import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CoverCache, normalizeCoverMime, readCoverDataUrl } from '@main/library/covers'
import { createPngBytes, createWavBytes, createWavWithTagsBytes } from '../helpers'

describe('CoverCache', () => {
  it('distinguishes never-seen from known-absent', () => {
    const cache = new CoverCache()
    expect(cache.get('a.mp3')).toBeUndefined()

    cache.set('a.mp3', null)
    expect(cache.get('a.mp3')).toBeNull()
  })

  it('returns a stored data url', () => {
    const cache = new CoverCache()
    cache.set('a.mp3', 'data:image/jpeg;base64,AAA')
    expect(cache.get('a.mp3')).toBe('data:image/jpeg;base64,AAA')
  })

  it('replaces an existing entry without growing', () => {
    const cache = new CoverCache()
    cache.set('a.mp3', 'data:image/jpeg;base64,AAA')
    cache.set('a.mp3', 'data:image/png;base64,BBB')
    expect(cache.size).toBe(1)
    expect(cache.get('a.mp3')).toBe('data:image/png;base64,BBB')
  })

  it('evicts the oldest entry once full', () => {
    const cache = new CoverCache()
    for (let i = 0; i < 64; i++) cache.set(`t${i}.mp3`, `data:${i}`)
    expect(cache.size).toBe(64)

    cache.set('overflow.mp3', 'data:x')
    expect(cache.size).toBe(64)
    expect(cache.get('t0.mp3')).toBeUndefined()
    expect(cache.get('t1.mp3')).toBe('data:1')
    expect(cache.get('overflow.mp3')).toBe('data:x')
  })

  it('clears', () => {
    const cache = new CoverCache()
    cache.set('a.mp3', 'data:x')
    cache.clear()
    expect(cache.size).toBe(0)
  })
})

describe('readCoverDataUrl', () => {
  let dir = ''
  let cache: CoverCache

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'covers-'))
    cache = new CoverCache()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const write = async (name: string, bytes: Uint8Array | string): Promise<string> => {
    const path = join(dir, name)
    await writeFile(path, typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes))
    return path
  }

  it('extracts embedded artwork as a data url', async () => {
    const path = await write('art.wav', createWavWithTagsBytes({ coverBytes: createPngBytes() }))

    const url = await readCoverDataUrl(path, cache)

    expect(url).toMatch(/^data:image\/png;base64,/)
  })

  it('produces base64 that decodes to the exact embedded bytes', async () => {
    const png = createPngBytes()
    const path = await write('art.wav', createWavWithTagsBytes({ coverBytes: png }))

    const url = await readCoverDataUrl(path, cache)
    const base64 = (url as string).slice('data:image/png;base64,'.length)

    expect(Buffer.from(base64, 'base64').equals(Buffer.from(png))).toBe(true)
  })

  it('reports the mime type taken from the tag', async () => {
    const path = await write(
      'art.wav',
      createWavWithTagsBytes({ mime: 'image/jpeg', coverBytes: createPngBytes() })
    )

    expect(await readCoverDataUrl(path, cache)).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('returns null when the file has no artwork', async () => {
    const path = await write('plain.wav', createWavBytes())

    expect(await readCoverDataUrl(path, cache)).toBeNull()
  })

  it('returns null for a file that is not audio', async () => {
    const path = await write('notes.txt', 'not audio at all')

    expect(await readCoverDataUrl(path, cache)).toBeNull()
  })

  it('returns null for a missing file instead of throwing', async () => {
    expect(await readCoverDataUrl(join(dir, 'gone.mp3'), cache)).toBeNull()
  })

  it('serves a repeated lookup from cache without touching the file', async () => {
    const path = await write('art.wav', createWavWithTagsBytes())
    const first = await readCoverDataUrl(path, cache)
    // Removing the file proves the second call is answered from cache.
    await rm(path)

    expect(await readCoverDataUrl(path, cache)).toBe(first)
  })

  it('caches a missing-artwork result as null', async () => {
    const path = await write('plain.wav', createWavBytes())
    expect(await readCoverDataUrl(path, cache)).toBeNull()
    await rm(path)

    expect(cache.get(path)).toBeNull()
    expect(await readCoverDataUrl(path, cache)).toBeNull()
  })

  it('shares results across callers through the cache', async () => {
    const path = await write('art.wav', createWavWithTagsBytes())

    expect(await readCoverDataUrl(path, cache)).toBe(await readCoverDataUrl(path, cache))
  })

  it('drops a hostile embedded mime instead of serving it', async () => {
    const path = await write(
      'evil.wav',
      createWavWithTagsBytes({
        mime: 'text/html',
        coverBytes: Buffer.from('<script>alert(1)</script>')
      })
    )

    expect(await readCoverDataUrl(path, cache)).toBeNull()
  })
})

describe('normalizeCoverMime', () => {
  it('allows images and canonicalizes the jpg alias', () => {
    expect(normalizeCoverMime('image/jpeg')).toBe('image/jpeg')
    expect(normalizeCoverMime('image/png')).toBe('image/png')
    expect(normalizeCoverMime('image/gif')).toBe('image/gif')
    expect(normalizeCoverMime('image/webp')).toBe('image/webp')
    expect(normalizeCoverMime('image/jpg')).toBe('image/jpeg')
    expect(normalizeCoverMime(' IMAGE/PNG ')).toBe('image/png')
  })

  it('rejects everything else', () => {
    expect(normalizeCoverMime('text/html')).toBeNull()
    expect(normalizeCoverMime('application/octet-stream')).toBeNull()
    expect(normalizeCoverMime('')).toBeNull()
    expect(normalizeCoverMime('image/svg+xml')).toBeNull()
  })
})

