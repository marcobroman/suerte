import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryCache } from '@main/library/cache'
import { scanLibrary } from '@main/library/scan'
import type { ScanProgress } from '@shared/types'
import { at, createWavBytes } from '../helpers'

let root: string

async function writeWav(name: string, seconds = 1): Promise<string> {
  const path = join(root, name)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, createWavBytes({ seconds }))
  return path
}

/** Exact millisecond timestamp, so repeated stats compare byte-identical. */
const FIXED_TIME = new Date(1700000000000)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'eq-scan-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scanLibrary', () => {
  it('returns an empty tree for a missing root', async () => {
    const outcome = await scanLibrary({ roots: [join(root, 'nope')], cache: new LibraryCache() })

    expect(outcome.tracks).toEqual([])
    expect(outcome.tree.artists).toEqual([])
    expect(outcome.tree.albums).toEqual([])
  })

  it('finds audio files recursively and ignores other files', async () => {
    await writeWav('a.wav')
    await writeFile(join(root, 'notes.txt'), 'ignore me')

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.tracks).toHaveLength(1)
    expect(outcome.tracks[0]?.path).toBe(join(root, 'a.wav'))
  })

  it('never indexes symlinks, even ones pointing at audio', async () => {
    const target = await writeWav('real.wav')
    try {
      await symlink(target, join(root, 'link.wav'))
    } catch {
      // No symlink privilege on this machine (Windows without Developer
      // Mode): the serve-time canonical check below still covers escapes.
      return
    }

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.tracks.map((track) => track.path)).toEqual([target])
  })

  it('descends into subdirectories', async () => {
    await writeWav('top.wav')
    await writeWav(join('deep', 'nested', 'inner.wav'))

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.tracks).toHaveLength(2)
    expect(outcome.tracks.map((track) => track.path)).toContain(
      join(root, 'deep', 'nested', 'inner.wav')
    )
  })

  it('accepts a single file as a root', async () => {
    const path = await writeWav('solo.wav')

    const outcome = await scanLibrary({ roots: [path], cache: new LibraryCache() })

    expect(outcome.tracks).toHaveLength(1)
    expect(outcome.tracks[0]?.path).toBe(path)
  })

  it('parses real duration and falls back to the filename for untagged audio', async () => {
    await writeWav('Sunrise Chaser.wav', 2)

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })
    const track = at(outcome.tracks, 0)

    expect(track.title).toBe('Sunrise Chaser')
    expect(track.durationSec).toBeCloseTo(2, 1)
    expect(track.sizeBytes).toBeGreaterThan(0)
    expect(outcome.result.failed).toBe(0)
  })

  it('groups untagged audio under the unknown artist', async () => {
    await writeWav('one.wav')
    await writeWav('two.wav')

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.tree.artists).toHaveLength(1)
    expect(outcome.tree.albums).toHaveLength(1)
  })

  it('reports counts on a first scan', async () => {
    await writeWav('a.wav')
    await writeWav('b.wav')

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.result.added).toBe(2)
    expect(outcome.result.changed).toBe(0)
    expect(outcome.result.removed).toBe(0)
    expect(outcome.result.failed).toBe(0)
  })

  it('counts unparseable files as failed without aborting the scan', async () => {
    await writeWav('good.wav')
    await writeFile(join(root, 'broken.wav'), new Uint8Array([1, 2, 3, 4]))

    const outcome = await scanLibrary({ roots: [root], cache: new LibraryCache() })

    expect(outcome.tracks).toHaveLength(1)
    expect(outcome.tracks[0]?.title).toBe('good')
    expect(outcome.result.failed).toBe(1)
  })

  it('reuses cached metadata when size and mtime are unchanged', async () => {
    const path = await writeWav('cached.wav')
    // Pin mtime to an exact millisecond; restoring sub-millisecond precision is
    // not possible through utimes, and the cache keys on the floored value.
    await utimes(path, FIXED_TIME, FIXED_TIME)
    const cache = new LibraryCache()

    const first = await scanLibrary({ roots: [root], cache })
    expect(first.result.added).toBe(1)

    const before = await stat(path)
    // Same byte length and same mtime, but the contents are now unparseable. A
    // re-parse would fail, so a clean second scan proves the cache was used.
    await writeFile(path, new Uint8Array(before.size))
    await utimes(path, FIXED_TIME, FIXED_TIME)

    const second = await scanLibrary({ roots: [root], cache })

    expect(second.result.failed).toBe(0)
    expect(second.result.added).toBe(0)
    expect(second.result.changed).toBe(0)
    expect(second.tracks).toHaveLength(1)
    expect(second.tracks[0]?.title).toBe('cached')
  })

  it('re-parses a file whose contents changed', async () => {
    const path = await writeWav('first.wav')
    const cache = new LibraryCache()

    await scanLibrary({ roots: [root], cache })

    await writeWav('second.wav')
    await rm(path)

    const outcome = await scanLibrary({ roots: [root], cache })

    expect(outcome.tracks).toHaveLength(1)
    expect(outcome.tracks[0]?.title).toBe('second')
    expect(outcome.result.added).toBe(1)
    expect(outcome.result.removed).toBe(1)
  })

  it('drops files that disappeared from disk', async () => {
    await writeWav('a.wav')
    await writeWav('b.wav')
    const cache = new LibraryCache()
    await scanLibrary({ roots: [root], cache })

    await rm(join(root, 'b.wav'))
    const outcome = await scanLibrary({ roots: [root], cache })

    expect(outcome.tracks).toHaveLength(1)
    expect(outcome.result.removed).toBe(1)
    expect(outcome.tree.albums[0]?.trackPaths).toHaveLength(1)
  })

  it('skips remaining files once cancelled and does not count them as failures', async () => {
    for (let i = 0; i < 6; i++) await writeWav(`t${i}.wav`, 1)
    let checks = 0

    const outcome = await scanLibrary({
      roots: [root],
      cache: new LibraryCache(),
      concurrency: 1,
      // Allow the first two files through, then cancel.
      isCancelled: () => ++checks > 2
    })

    expect(outcome.tracks).toHaveLength(2)
    expect(outcome.result.failed).toBe(0)
    expect(outcome.result.cancelled).toBe(4)
  })

  it('parses nothing when cancelled before the scan starts', async () => {
    await writeWav('a.wav')
    await writeWav('b.wav')

    const outcome = await scanLibrary({
      roots: [root],
      cache: new LibraryCache(),
      isCancelled: () => true
    })

    expect(outcome.tracks).toHaveLength(0)
    expect(outcome.result.cancelled).toBe(2)
    expect(outcome.result.failed).toBe(0)
  })

  it('reports progress that reaches the total', async () => {
    await writeWav('a.wav')
    await writeWav('b.wav')
    const reports: ScanProgress[] = []

    await scanLibrary({
      roots: [root],
      cache: new LibraryCache(),
      onProgress: (progress) => reports.push(progress)
    })

    expect(reports.length).toBeGreaterThan(0)
    const last = at(reports, reports.length - 1)
    expect(last.scanned).toBe(last.total)
    expect(last.total).toBe(2)
  })

  it('does not report progress when no listener is attached', async () => {
    await writeWav('a.wav')

    await expect(
      scanLibrary({ roots: [root], cache: new LibraryCache() })
    ).resolves.toBeDefined()
  })
})
