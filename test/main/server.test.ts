import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import NodeID3 from 'node-id3'
import { CoverCache, readCoverDataUrl } from '@main/library/covers'
import { clientPathIn, createLibraryServer, insideRoots, trackId, type LibraryServer } from '@main/server'
import { writeTrackTags } from '@main/library/tags'
import type { LibrarySummary } from '@shared/ipc'
import { createPngBytes } from '../helpers'

const TOKEN = 'test-token-123'

describe('clientPathIn', () => {
  it('pins requests inside the client dir, including dot segments', () => {
    // resolve() absolutizes, so expectations go through it too.
    expect(clientPathIn('/app/client', '/assets/app.js')).toBe(
      resolve('/app/client', 'assets', 'app.js')
    )
    expect(clientPathIn('/app/client', '/../secret')).toBeNull()
    expect(clientPathIn('/app/client', '/assets/../../secret')).toBeNull()
  })

  it('rejects siblings that merely share a prefix', () => {
    expect(clientPathIn('/app/client', '/../client-other/x.js')).toBeNull()
  })
})

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
  let clientDir = ''
  let server: LibraryServer | null = null
  let base = ''

  async function start(): Promise<string> {
    const covers = new CoverCache()
    const song = join(dir, 'song.mp3')
    const art = join(dir, 'art.mp3')
    const entry = (path: string, title: string) => ({
      path,
      title,
      artist: 'A',
      album: 'B',
      trackNo: 1,
      discNo: null,
      year: null,
      durationSec: 10,
      mtimeMs: 0,
      sizeBytes: 1000
    })
    const summary: LibrarySummary = {
      tree: {
        artists: [{ name: 'A', albumKeys: ['A|B'] }],
        albums: [
          {
            key: 'A|B',
            artist: 'A',
            title: 'B',
            year: null,
            trackPaths: [song]
          }
        ]
      },
      tracks: [entry(song, 'Song'), entry(art, 'Art')],
      trackCount: 2,
      roots: [dir],
      missingRoots: [],
      scanning: false
    }
    server = createLibraryServer({
      getPort: () => 0,
      getToken: () => TOKEN,
      getSummary: () => summary,
      readCover: (path) => readCoverDataUrl(path, covers),
      getRoots: () => [dir],
      getClientDir: () => clientDir
    })
    const url = await server.start()
    base = url.replace('localhost', '127.0.0.1')
    return base
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'server-lib-'))
    outside = await mkdtemp(join(tmpdir(), 'server-out-'))
    clientDir = await mkdtemp(join(tmpdir(), 'server-client-'))
    await writeFile(join(dir, 'song.mp3'), Buffer.alloc(1000, 7))
    await writeFile(join(outside, 'secret.mp3'), Buffer.alloc(100, 9))
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(clientDir, 'index.html'), '<html>onda</html>')
    await mkdir(join(clientDir, 'assets'), { recursive: true })
    await writeFile(join(clientDir, 'assets', 'app.js'), 'console.log(1)')
  })

  afterEach(async () => {
    await server?.stop()
    server = null
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(clientDir, { recursive: true, force: true })
  })

  it('serves the library with a bearer token or query token', async () => {
    await start()

    const header = await fetch(`${base}/api/library`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(header.status).toBe(200)
    const body = (await header.json()) as Record<string, unknown>
    expect(body).toMatchObject({ trackCount: 2 })
    expect(body).not.toHaveProperty('roots')
    expect(body).not.toHaveProperty('missingRoots')

    const query = await fetch(`${base}/api/library?token=${TOKEN}`)
    expect(query.status).toBe(200)
  })

  it('serves opaque ids instead of absolute paths', async () => {
    await start()
    const id = trackId(join(dir, 'song.mp3'))

    const response = await fetch(`${base}/api/library?token=${TOKEN}`)
    const body = (await response.json()) as {
      tracks: { path: string }[]
      tree: { albums: { trackPaths: string[] }[] }
    }
    expect(body.tracks.map((track) => track.path)).toEqual([
      id,
      trackId(join(dir, 'art.mp3'))
    ])
    expect(body.tree.albums[0]?.trackPaths).toEqual([id])
    expect(JSON.stringify(body)).not.toContain('server-lib-')

    const stream = await fetch(`${base}/api/stream?id=${id}&token=${TOKEN}`)
    expect(stream.status).toBe(200)
    expect(new Uint8Array(await stream.arrayBuffer())).toHaveLength(1000)
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
    const id = trackId(join(dir, 'song.mp3'))
    const url = `${base}/api/stream?id=${id}&token=${TOKEN}`

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

  it('refuses unknown ids, missing ids, and bad requests', async () => {
    await start()
    const at = (id: string): string => `${base}/api/stream?id=${encodeURIComponent(id)}&token=${TOKEN}`

    // Unknown ids 404: traversal is structurally impossible, and anything
    // outside the library simply has no id.
    expect((await fetch(at('0'.repeat(64)))).status).toBe(404)
    expect((await fetch(at('../../etc/passwd'))).status).toBe(404)
    expect((await fetch(at(join(outside, 'secret.mp3')))).status).toBe(404)
    expect((await fetch(`${base}/api/stream?token=${TOKEN}`)).status).toBe(400)
    expect((await fetch(`${base}/api/nope?token=${TOKEN}`)).status).toBe(404)
    expect((await fetch(`${base}/api/library`, { method: 'POST' })).status).toBe(405)
  })

  it('serves embedded covers and 404s without art', async () => {
    await start()
    const artPath = join(dir, 'art.mp3')
    const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(417 - 4, 0)])
    await writeFile(artPath, Buffer.concat([NodeID3.create({ title: 'T' }), frame, frame]))
    const embedded = await writeTrackTags(artPath, {
      art: { mime: 'image/png', data: createPngBytes() }
    })
    expect(embedded.ok).toBe(true)
    const at = (id: string): string => `${base}/api/cover?id=${encodeURIComponent(id)}&token=${TOKEN}`

    const art = await fetch(at(trackId(artPath)))
    expect(art.status).toBe(200)
    expect(art.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await art.arrayBuffer())).toEqual(createPngBytes())

    const missing = await fetch(at(trackId(join(dir, 'song.mp3'))))
    expect(missing.status).toBe(404)
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
      const pushed = JSON.parse(text.slice('data: '.length)) as Record<string, unknown>
      expect(pushed).toMatchObject({ trackCount: 2 })
      expect(pushed).not.toHaveProperty('roots')
    } finally {
      await reader.cancel()
    }
  })

  it('stops listening on demand', async () => {
    await start()
    await server?.stop()

    await expect(fetch(`${base}/api/library?token=${TOKEN}`)).rejects.toThrow()
  })

  it('serves the client shell publicly with an SPA fallback', async () => {
    await start()

    // No token needed: a phone must load the page to enter its token.
    const root = await fetch(`${base}/`)
    expect(root.status).toBe(200)
    expect(root.headers.get('content-type')).toContain('text/html')
    expect(await root.text()).toContain('onda')

    const asset = await fetch(`${base}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('javascript')
    expect(await asset.text()).toContain('console.log(1)')

    const route = await fetch(`${base}/some/route`, { headers: { accept: 'text/html' } })
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('onda')

    const missingAsset = await fetch(`${base}/assets/missing.js`)
    expect(missingAsset.status).toBe(404)
  })
})
