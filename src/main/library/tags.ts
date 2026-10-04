import { randomUUID } from 'node:crypto'
import { copyFile, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'
import { extensionOf } from '@shared/audio-files'
import type { TagEdits, TagWriteResult } from '@shared/types'

/** Step 1 covers MP3 only; other formats report `unsupported-format`. */
export function isTagWritable(path: string): boolean {
  return extensionOf(path) === '.mp3'
}

/**
 * Strips unknown keys and mistyped values from renderer-supplied edits, so the
 * writer only ever sees the shape it verified. Invalid fields are dropped
 * rather than failing the whole edit; the dialog validates up front.
 */
export function sanitizeTagEdits(value: unknown): TagEdits {
  if (typeof value !== 'object' || value === null) return {}
  const input = value as Record<string, unknown>
  const edits: {
    title?: string
    artist?: string
    album?: string
    trackNo?: number
    discNo?: number
    year?: number
    art?: { mime: string; data: Uint8Array }
  } = {}
  for (const field of ['title', 'artist', 'album'] as const) {
    const candidate = input[field]
    if (typeof candidate === 'string') edits[field] = candidate
  }
  for (const field of ['trackNo', 'discNo', 'year'] as const) {
    const candidate = input[field]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) edits[field] = candidate
  }
  const art = input['art']
  if (typeof art === 'object' && art !== null) {
    const mime = (art as Record<string, unknown>)['mime']
    const data = (art as Record<string, unknown>)['data']
    if (typeof mime === 'string' && data instanceof Uint8Array) {
      edits.art = { mime, data }
    }
  }
  return edits
}

const SUPPORTED_ART_MIMES = new Set(['image/jpeg', 'image/png'])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // Best-effort cleanup of our own temp file; never masks the real outcome.
  }
}

/**
 * Structural sniff: an ID3v2 header up front, or MPEG frames music-metadata
 * recognises. music-metadata never throws on garbage (it returns empty
 * metadata), so parsing alone cannot guard the write path.
 */
async function looksLikeMp3(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(3)
    const { bytesRead } = await handle.read(head, 0, 3, 0)
    if (bytesRead === 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true
  } catch {
    return false
  } finally {
    await handle.close()
  }
  try {
    const { format } = await parseFile(path, { duration: false })
    return format.container === 'MPEG'
  } catch {
    return false
  }
}

/**
 * Rewrites an MP3's tags with backup, write, and verify-by-reparse. On any
 * failure after the backup the original bytes are restored, so a failed edit
 * never leaves a half-written file behind.
 */
export async function writeTrackTags(path: string, edits: TagEdits): Promise<TagWriteResult> {
  if (!isTagWritable(path)) return { path, ok: false, error: { kind: 'unsupported-format' } }
  if (edits.discNo !== undefined) {
    return { path, ok: false, error: { kind: 'unsupported-field', field: 'discNo' } }
  }
  if (edits.art !== undefined && !SUPPORTED_ART_MIMES.has(edits.art.mime.toLowerCase())) {
    return { path, ok: false, error: { kind: 'unsupported-field', field: 'art' } }
  }

  try {
    await stat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { path, ok: false, error: { kind: 'not-found' } }
    }
    return { path, ok: false, error: { kind: 'unreadable', message: messageOf(error) } }
  }

  // Refuse to touch files with no MP3 structure, so non-audio masquerading
  // as MP3 is never corrupted by a tag write.
  if (!(await looksLikeMp3(path))) {
    return { path, ok: false, error: { kind: 'unreadable', message: 'not an MP3 file' } }
  }

  const backup = join(tmpdir(), `equalizer-tagbak-${randomUUID()}`)
  try {
    await copyFile(path, backup)
  } catch (error: unknown) {
    return { path, ok: false, error: { kind: 'write-failed', message: `backup: ${messageOf(error)}` } }
  }
  const restore = async (): Promise<void> => {
    try {
      await copyFile(backup, path)
      await removeQuietly(backup)
    } catch {
      // Leave the backup in the temp dir; losing it would be worse than leaking it.
    }
  }

  try {
    // update() merges into the existing tag, preserving unknown frames.
    const tags: NodeID3.Tags = {}
    if (edits.title !== undefined) tags.title = edits.title
    if (edits.artist !== undefined) tags.artist = edits.artist
    if (edits.album !== undefined) tags.album = edits.album
    if (edits.trackNo !== undefined) tags.trackNumber = String(Math.trunc(edits.trackNo))
    if (edits.year !== undefined) tags.year = String(Math.trunc(edits.year))
    if (edits.art !== undefined) {
      tags.image = {
        mime: edits.art.mime,
        type: { id: 3, name: 'front cover' },
        description: '',
        imageBuffer: Buffer.from(edits.art.data)
      }
    }
    // Success resolves with anything but false; failures reject.
    const wrote = await NodeID3.Promise.update(tags, path)
    if (wrote === false) {
      await restore()
      return { path, ok: false, error: { kind: 'write-failed', message: 'tag writer reported failure' } }
    }
  } catch (error: unknown) {
    await restore()
    return { path, ok: false, error: { kind: 'write-failed', message: messageOf(error) } }
  }

  try {
    const { common } = await parseFile(path, { duration: false, skipCovers: edits.art === undefined })
    const stale: string[] = []
    if (edits.title !== undefined && (common.title ?? '').trim() !== edits.title.trim()) {
      stale.push('title')
    }
    if (edits.artist !== undefined && (common.artist ?? '').trim() !== edits.artist.trim()) {
      stale.push('artist')
    }
    if (edits.album !== undefined && (common.album ?? '').trim() !== edits.album.trim()) {
      stale.push('album')
    }
    if (edits.trackNo !== undefined && (common.track.no ?? null) !== Math.trunc(edits.trackNo)) {
      stale.push('trackNo')
    }
    if (edits.year !== undefined && (common.year ?? null) !== Math.trunc(edits.year)) {
      stale.push('year')
    }
    if (edits.art !== undefined && (common.picture?.length ?? 0) === 0) stale.push('art')
    if (stale.length > 0) {
      await restore()
      return {
        path,
        ok: false,
        error: { kind: 'verify-failed', message: `fields did not persist: ${stale.join(', ')}` }
      }
    }
  } catch (error: unknown) {
    await restore()
    return { path, ok: false, error: { kind: 'verify-failed', message: messageOf(error) } }
  }

  await removeQuietly(backup)
  return { path, ok: true }
}
