import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import NodeID3 from 'node-id3'
import { CoverCache, readCoverDataUrl } from '@main/library/covers'
import { createLibraryServer, insideRoots, type LibraryServer } from '@main/server'
import { createPngBytes } from '../helpers'

const TOKEN = 'test-token-123'

describe('insideRoots', () => {
  it('accepts the root itself and anything under it', () => {
    expect(insideRoots(['/music'], '/music')).toBe(true)
    expect(insideRoots(['/music'], '/music/a/b.mp3')).toBe(true)
  })

  it('rejects siblings, escapes, and other drives', () => {
    expect(insideRoots(['/music'], '/music2/x.mp3')).toBe(false)
    expect(insideRoots(['/music'], '/music/../etc/passwd')).toBe(false)
    expect(insideRoots(['/music'], '/other/x.mp3')).toBe(false)
    expect(insideRoots(['C:\\music'], 'D:\\music\\x.mp3')).toBe(false)
  })

  it('supports roots that are individual files', () => {
    expect(insideRoots(['/music/a.mp3'], '/music/a.mp3')).toBe(true)
    expect(insideRoots(['/music/a.mp3'], '/music/b.mp3')).toBe(false)
  })
})

describe('library server', () => {
  let dir = ''
  let outside = ''
  let server: LibraryServer | null = null
  let base = ''

  async function start(): Promise<string> {
    const covers = new CoverCache()
    server = createLibraryServer({
      getPort: () => 0,
      getToken: () => TOKEN,
      getSummary: () => ({
        tree: { artists: [], albums: [] },
        tracks: [],
        trackCount: 0,
        roots: [dir],
        missingRoots: [],
        scanning: false
      }),
      readCover: (path) => readCoverDataUrl(path, covers),
      getRoots: () => [dir]
    })
    const url = await server.start()
    base = url.replace('localhost', '127.0.0.1')
    return base
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'server-lib-'))
    outside = await mkdtemp(join(tmpdir(), 'server-out-'))
    await writeFile(join(dir, 'song.mp3'), Buffer.alloc(1000, 7))
    await writeFile(join(outside, 'secret.mp3'), Buffer.alloc(100, 9))
    await mkdir(join(dir, 'sub'), { recursive: true })
  })

  afterEach(async () => {
    await server?.stop()
    server = null
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('serves the library with a bearer token or query token', async () => {
    await start()

    const header = await fetch(`${base}/api/library`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(header.status).toBe(200)
    expect((await header.json()) as { trackCount: number }).toMatchObject({ trackCount: 0 })

    const query = await fetch(`${base}/api/library?token=${TOKEN}`)
    expect(query.status).toBe(200)
  })

  it('rejects missing and wrong tokens', async () => {
    await start()

    expect((await fetch(`${base}/api/library`)).status).toBe(401)
    expect(
      (await fetch(`${base}/api/library`, { headers: { authorization: 'Bearer nope' } })).status
    ).toBe(401)
  })

  it('streams whole files with a mime type and range support', async () => {
    await start()
    const url = `${base}/api/stream?path=${encodeURIComponent(join(dir, 'song.mp3'))}&token=${TOKEN}`

    const full = await fetch(url)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-type')).toBe('audio/mpeg')
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(new Uint8Array(await full.arrayBuffer())).toHaveLength(1000)

    const part = await fetch(url, { headers: { range: 'bytes=10-19' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual(new Array(10).fill(7))

    const tail = await fetch(url, { headers: { range: 'bytes=-5' } })
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 995-999/1000')

    const past = await fetch(url, { headers: { range: 'bytes=9999-10000' } })
    expect(past.status).toBe(416)
  })

  it('refuses paths outside the library, missing files, and directories', async () => {
    await start()
    const at = (path: string): string => `${base}/api/stream?path=${encodeURIComponent(path)}&token=${TOKEN}`

    expect((await fetch(at(join(outside, 'secret.mp3')))).status).toBe(403)
    expect((await fetch(at(join(dir, '..', 'x.mp3')))).status).toBe(403)
    expect((await fetch(at(join(dir, 'gone.mp3')))).status).toBe(404)
    expect((await fetch(at(join(dir, 'sub')))).status).toBe(404)
    expect((await fetch(`${base}/api/stream?token=${TOKEN}`)).status).toBe(400)
    expect((await fetch(`${base}/api/nope?token=${TOKEN}`)).status).toBe(404)
    expect((await fetch(`${base}/api/library`, { method: 'POST' })).status).toBe(405)
  })

  it('serves embedded covers and 404s without art', async () => {
    await start()
    const artPath = join(dir, 'art.mp3')
    await writeFile(
      artPath,
      NodeID3.create({
        title: 'T',
        image: {
          mime: 'image/png',
          type: { id: 3, name: 'front cover' },
          description: '',
          imageBuffer: Buffer.from(createPngBytes())
        }
      })
    )
    const at = (path: string): string => `${base}/api/cover?path=${encodeURIComponent(path)}&token=${TOKEN}`

    const art = await fetch(at(artPath))
    expect(art.status).toBe(200)
    expect(art.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await art.arrayBuffer())).toEqual(createPngBytes())

    expect((await fetch(at(join(dir, 'song.mp3')))).status).toBe(404)
  })

  it('pushes library changes to event subscribers', async () => {
    await start()
    const response = await fetch(`${base}/api/events?token=${TOKEN}`, {
      headers: { accept: 'text/event-stream' }
    })
    expect(response.status).toBe(200)
    const body = response.body
    if (!body) throw new Error('expected a stream body')
    const reader = body.getReader()
    try {
      const pending = reader.read()
      server?.pushLibraryChanged()
      const chunk = await pending
      const text = Buffer.from(chunk.value ?? []).toString('utf8')
      expect(text.startsWith('data: ')).toBe(true)
      expect(JSON.parse(text.slice('data: '.length)) as { trackCount: number }).toMatchObject({
        trackCount: 0
      })
    } finally {
      await reader.cancel()
    }
  })

  it('stops listening on demand', async () => {
    await start()
    await server?.stop()

    await expect(fetch(`${base}/api/library?token=${TOKEN}`)).rejects.toThrow()
  })
})
