import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { parseFile, type IAudioMetadata } from 'music-metadata'
import { isAudioFile } from '@shared/audio-files'
import type { LibraryTree, ScanProgress, ScanResult, Track } from '@shared/types'
import { mapLimit } from '../util/map-limit'
import type { CacheKeyParts } from './cache'
import { LibraryCache } from './cache'
import { groupLibrary } from './group'

const DEFAULT_CONCURRENCY = 12
const STAT_CONCURRENCY = 32
const PROGRESS_INTERVAL_MS = 80

export interface ScanOptions {
  readonly roots: readonly string[]
  readonly cache: LibraryCache
  readonly concurrency?: number
  readonly onProgress?: (progress: ScanProgress) => void
  readonly isCancelled?: () => boolean
}

export interface ScanOutcome {
  readonly tree: LibraryTree
  readonly tracks: readonly Track[]
  readonly result: ScanResult
}

/**
 * Recursively collects audio files under each root. Roots may also be individual
 * files. Symlinked directories are not followed, matching readdir's own behaviour.
 */
async function collectAudioFiles(roots: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()

  for (const root of roots) {
    let rootStats
    try {
      rootStats = await stat(root)
    } catch {
      continue
    }

    if (rootStats.isFile()) {
      if (isAudioFile(root)) seen.add(root)
      continue
    }
    if (!rootStats.isDirectory()) continue

    let entries
    try {
      entries = await readdir(root, { withFileTypes: true, recursive: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = join(entry.parentPath, entry.name)
      if (isAudioFile(full)) seen.add(full)
    }
  }

  return [...seen]
}

async function statAll(paths: readonly string[]): Promise<CacheKeyParts[]> {
  const parts = await mapLimit(paths, STAT_CONCURRENCY, async (path) => {
    try {
      const stats = await stat(path)
      // Floor the timestamp: sub-millisecond float noise would defeat the cache.
      return { path, mtimeMs: Math.floor(stats.mtimeMs), sizeBytes: stats.size }
    } catch {
      return null
    }
  })
  return parts.filter((part): part is CacheKeyParts => part !== null)
}

function toTrack(parts: CacheKeyParts, metadata: IAudioMetadata): Track {
  const { common, format } = metadata
  const fallbackTitle = basename(parts.path, extname(parts.path))

  return {
    path: parts.path,
    title: common.title?.trim() || fallbackTitle,
    artist: common.artist?.trim() || common.albumartist?.trim() || '',
    album: common.album?.trim() || '',
    trackNo: common.track.no ?? null,
    discNo: common.disk.no ?? null,
    year: common.year ?? null,
    durationSec: format.duration ?? 0,
    mtimeMs: parts.mtimeMs,
    sizeBytes: parts.sizeBytes
  }
}

export async function scanLibrary(options: ScanOptions): Promise<ScanOutcome> {
  const { cache, onProgress, isCancelled } = options
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const startedAt = Date.now()

  const files = await collectAudioFiles(options.roots)
  const onDisk = await statAll(files)
  const previousPaths = new Set(cache.values().map((track) => track.path))

  const plan = cache.planAndApply(onDisk)

  let completed = plan.reusable.length
  let lastReport = Date.now()
  const report = (currentPath: string, done: boolean): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!done && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress({ scanned: completed, total: files.length, currentPath })
  }

  const parsed = await mapLimit(plan.needsParse, concurrency, async (parts) => {
    if (isCancelled?.()) return { kind: 'cancelled' as const }
    try {
      // Covers are skipped here and pulled on demand later; they dominate parse cost.
      const metadata = await parseFile(parts.path, { duration: true, skipCovers: true })
      return { kind: 'track' as const, track: toTrack(parts, metadata) }
    } catch {
      return { kind: 'failed' as const }
    } finally {
      completed += 1
      report(parts.path, false)
    }
  })

  report('', true)

  // A cancelled file is not an error, so it is counted separately from failures.
  const fresh: Track[] = []
  let failed = 0
  let cancelled = 0
  for (const outcome of parsed) {
    if (outcome.kind === 'track') fresh.push(outcome.track)
    else if (outcome.kind === 'failed') failed += 1
    else cancelled += 1
  }

  const reused = plan.reusable
    .map((parts) => cache.get(parts))
    .filter((track): track is Track => track !== undefined)

  for (const track of fresh) cache.set(track)

  const tracks = [...reused, ...fresh]
  const changed = fresh.filter((track) => previousPaths.has(track.path)).length
  const result: ScanResult = {
    added: fresh.length - changed,
    changed,
    removed: plan.staleKeys.length,
    failed,
    cancelled,
    durationMs: Date.now() - startedAt
  }

  return { tree: groupLibrary(tracks), tracks, result }
}
