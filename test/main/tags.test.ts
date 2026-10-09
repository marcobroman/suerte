import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import NodeID3 from 'node-id3'
import { parseFile } from 'music-metadata'
import { isTagWritable, sanitizeTagEdits, writeTrackTags } from '@main/library/tags'
import { createPngBytes } from '../helpers'

/** Tag block plus valid MPEG frames, so music-metadata parses a real file. */
function mp3Bytes(tags: NodeID3.Tags): Buffer {
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(417 - 4, 0)])
  return Buffer.concat([NodeID3.create(tags), frame, frame, frame])
}

const SEED: NodeID3.Tags = {
  title: 'Seed Title',
  artist: 'Seed Artist',
  album: 'Seed Album',
  trackNumber: '2',
  year: '1999',
  comment: { language: 'eng', text: 'keepme' }
}

describe('isTagWritable', () => {
  it('accepts mp3 regardless of case', () => {
    expect(isTagWritable('song.mp3')).toBe(true)
    expect(isTagWritable('SONG.MP3')).toBe(true)
  })

  it('rejects everything else for now', () => {
    expect(isTagWritable('song.flac')).toBe(false)
    expect(isTagWritable('song.m4a')).toBe(false)
    expect(isTagWritable('song.wav')).toBe(false)
  })
})

describe('sanitizeTagEdits', () => {
  it('keeps well-typed fields and drops the rest', () => {
    expect(
      sanitizeTagEdits({
        title: 'T',
        artist: 'A',
        album: 'B',
        trackNo: 3,
        discNo: 1,
        year: 2001,
        genre: 'Rock',
        trackNoTypo: 'x'
      })
    ).toEqual({ title: 'T', artist: 'A', album: 'B', trackNo: 3, discNo: 1, year: 2001 })
  })

  it('drops mistyped numbers and non-objects', () => {
    expect(sanitizeTagEdits({ trackNo: '3', year: Number.NaN, title: 7 })).toEqual({})
    expect(sanitizeTagEdits(null)).toEqual({})
    expect(sanitizeTagEdits('nope')).toEqual({})
  })

  it('keeps art only with a mime and real bytes', () => {
    const data = createPngBytes()
    expect(sanitizeTagEdits({ art: { mime: 'image/png', data } })).toEqual({
      art: { mime: 'image/png', data }
    })
    expect(sanitizeTagEdits({ art: { mime: 'image/png' } })).toEqual({})
    expect(sanitizeTagEdits({ art: 'png' })).toEqual({})
  })
})

describe('writeTrackTags', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tags-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seed(name = 'song.mp3'): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, mp3Bytes(SEED))
    return path
  }

  it('round-trips edited fields and preserves audio plus unknown frames', async () => {
    const path = await seed()

    const result = await writeTrackTags(path, {
      title: 'New Title',
      artist: 'New Artist',
      album: 'New Album',
      trackNo: 7,
      year: 2024
    })

    expect(result).toEqual({ path, ok: true })
    const { common, format } = await parseFile(path, { duration: false })
    expect(common.title).toBe('New Title')
    expect(common.artist).toBe('New Artist')
    expect(common.album).toBe('New Album')
    expect(common.track.no).toBe(7)
    expect(common.year).toBe(2024)
    expect(format.container).toBe('MPEG')
    // update() merges: the untouched comment frame survives the rewrite.
    expect(NodeID3.read(path).comment?.text).toBe('keepme')
  })

  it('leaves unspecified fields untouched', async () => {
    const path = await seed()

    const result = await writeTrackTags(path, { title: 'Only Title' })

    expect(result.ok).toBe(true)
    const { common } = await parseFile(path, { duration: false })
    expect(common.title).toBe('Only Title')
    expect(common.artist).toBe('Seed Artist')
    expect(common.track.no).toBe(2)
  })

  it('refuses to write through symlinks', async () => {
    const path = await seed('real.mp3')
    const link = join(dir, 'link.mp3')
    try {
      await symlink(path, link)
    } catch {
      // No link privilege on this machine; the IPC gate plus serve-time
      // canonical check still cover escapes where links can be planted.
      return
    }

    const result = await writeTrackTags(link, { title: 'Evil' })

    expect(result.ok).toBe(false)
  })

  it('embeds cover art verifiable by re-parse', async () => {
    const path = await seed()

    const result = await writeTrackTags(path, {
      art: { mime: 'image/png', data: createPngBytes() }
    })

    expect(result.ok).toBe(true)
    const { common } = await parseFile(path, { duration: false })
    expect(common.picture?.length).toBe(1)
    expect(common.picture?.[0]?.format).toBe('image/png')
  })

  it('rejects oversized cover art instead of embedding it', async () => {
    const path = await seed()

    const result = await writeTrackTags(path, {
      art: { mime: 'image/png', data: Buffer.alloc(12 * 1024 * 1024 + 1) }
    })

    expect(result).toEqual({ path, ok: false, error: { kind: 'unsupported-field', field: 'art' } })
  })

  it('rejects unsupported formats without touching the file', async () => {
    const path = join(dir, 'song.flac')
    await writeFile(path, mp3Bytes(SEED))
    const before = await readFile(path)

    const result = await writeTrackTags(path, { title: 'Nope' })

    expect(result.ok).toBe(false)
    expect(result.error?.kind).toBe('unsupported-format')
    expect(await readFile(path)).toEqual(before)
  })

  it('rejects disc numbers, which ID3 writing cannot express here', async () => {
    const path = await seed()
    const before = await readFile(path)

    const result = await writeTrackTags(path, { title: 'Nope', discNo: 1 })

    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ kind: 'unsupported-field', field: 'discNo' })
    expect(await readFile(path)).toEqual(before)
  })

  it('reports missing files', async () => {
    const path = join(dir, 'gone.mp3')

    const result = await writeTrackTags(path, { title: 'Nope' })

    expect(result.ok).toBe(false)
    expect(result.error?.kind).toBe('not-found')
  })

  it('refuses files that do not parse as audio', async () => {
    const path = join(dir, 'fake.mp3')
    await writeFile(path, 'definitely not audio')
    const before = await readFile(path)

    const result = await writeTrackTags(path, { title: 'Nope' })

    expect(result.ok).toBe(false)
    expect(result.error?.kind).toBe('unreadable')
    expect(await readFile(path)).toEqual(before)
  })
})
