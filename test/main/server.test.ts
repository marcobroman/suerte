import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import NodeID3 from 'node-id3'
import { CoverCache, readCoverDataUrl } from '@main/library/covers'
import { ensureServerCert } from '@main/cert'
import { clientPathIn, createLibraryServer, bucketIp, insideRoots, lanBaseUrl, lanBaseUrls, selectServerTransport, trackId, type LibraryServer } from '@main/server'
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

  it.runIf(process.platform === 'win32')('matches case-insensitively on Windows', () => {
    expect(insideRoots(['C:\\music'], 'c:\\MUSIC\\a.mp3')).toBe(true)
    expect(insideRoots(['C:\\music'], 'C:\\MUSIC')).toBe(true)
    expect(insideRoots(['C:\\music'], 'C:\\other\\a.mp3')).toBe(false)
  })
})
describe('bucketIp', () => {
  const socket = (remoteAddress: string | undefined) =>
    ({ socket: { remoteAddress } }) as unknown as Parameters<typeof bucketIp>[0]

  it('folds IPv6-mapped IPv4 onto the same bucket', () => {
    expect(bucketIp(socket('::ffff:192.168.1.5'))).toBe('192.168.1.5')
    expect(bucketIp(socket('192.168.1.5'))).toBe('192.168.1.5')
  })

  it('passes through anything else untouched', () => {
    expect(bucketIp(socket('::1'))).toBe('::1')
    expect(bucketIp(socket(undefined))).toBe('unknown')
  })
})
describe('lanBaseUrls', () => {
  it('lists every reachable address with the right scheme', () => {
    for (const url of lanBaseUrls(4280)) {
      expect(url.startsWith('http://')).toBe(true)
      expect(url.endsWith(':4280')).toBe(true)
      expect(url).not.toContain('127.0.0.1')
    }
    for (const url of lanBaseUrls(4280, true)) {
      expect(url.startsWith('https://')).toBe(true)
    }
    // The legacy single-URL helper is the first of the list (or null).
    expect(lanBaseUrl(4280)).toBe(lanBaseUrls(4280)[0] ?? null)
  })
})

/**
 * Self-signed test requests opt out of chain verification — exactly what a
 * phone does after confirming the fingerprint once.
 */
function getInsecure(url: string): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { rejectUnauthorized: false }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers
        })
      )
      response.on('error', reject)
    }).on('error', reject)
  })
}

describe('selectServerTransport', () => {
  const tls = { cert: 'c', key: 'k' }

  it('fails closed without a certificate unless insecure is allowed', () => {
    expect(selectServerTransport(tls, false)).toBe('https')
    expect(selectServerTransport(tls, true)).toBe('https')
    expect(selectServerTransport(null, true)).toBe('http')
    expect(selectServerTransport(null, false)).toBe('disabled')
  })
})

describe('library server', () => {
  let dir = ''
  let outside = ''
  let clientDir = ''
  let server: LibraryServer | null = null
  let base = ''
  let savedSessions: { id: string; createdAt: number }[] = []
  let savedDevices: { token: string; name: string; createdAt: number; lastSeen: number }[] = []

  async function start(
    initial: { id: string; createdAt: number; lastSeen?: number }[] = [],
    initialDevices: { token: string; name: string; createdAt: number; lastSeen: number }[] = [],
    tls: { cert: string; key: string } | null = null,
    readCoverImpl: ((path: string) => Promise<string | null>) | null = null,
    extraPaths: string[] = []
  ): Promise<string> {
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
      tracks: [entry(song, 'Song'), entry(art, 'Art'), ...extraPaths.map((path) => entry(path, 'Link'))],
      trackCount: 2,
      roots: [dir],
      missingRoots: [],
      scanning: false
    }
    server = createLibraryServer({
      getPort: () => 0,
      getToken: () => TOKEN,
      getTls: () => tls,
      getAllowInsecure: () => true,
      getSessions: () =>
        initial.map((session) => ({
          id: session.id,
          createdAt: session.createdAt,
          lastSeen: session.lastSeen ?? session.createdAt
        })),
      saveSessions: (sessions) => {
        savedSessions = [...sessions]
        return Promise.resolve()
      },
      getDevices: () => initialDevices,
      saveDevices: (devices) => {
        savedDevices = devices.map((device) => ({ ...device }))
        return Promise.resolve()
      },
      getSummary: () => summary,
      readCover: (path) => (readCoverImpl ?? ((p) => readCoverDataUrl(p, covers)))(path),
      getRoots: () => [dir],
      getClientDir: () => clientDir
    })
    const url = await server.start()
    base = url.replace('localhost', '127.0.0.1')
    return base
  }

  beforeEach(async () => {
    savedSessions = []
    savedDevices = []
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

  it('rate-limits handshake attempts per IP with a retry hint', async () => {
    await start()
    const attempt = (): Promise<Response> =>
      fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'nope' })
      })

    for (let i = 0; i < 10; i++) {
      expect((await attempt()).status).toBe(401)
    }
    const limited = await attempt()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('sends hardening headers on every response', async () => {
    await start()

    const response = await fetch(`${base}/api/library?token=${TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  })

  it('keeps serving subscribers under the global cap', async () => {
    // Same-IP eviction (next test) keeps the total under the global cap, so
    // one peer alone can never reach the 503 — it just rotates its own
    // oldest sockets out. This pins that steady state.
    await start()
    const controllers: AbortController[] = []
    try {
      for (let i = 0; i < 20; i++) {
        const controller = new AbortController()
        controllers.push(controller)
        // Headers complete so the status is known; the unread body keeps
        // each subscription socket open on both ends.
        const response = await fetch(`${base}/api/events?token=${TOKEN}`, {
          signal: controller.signal
        })
        expect(response.status).toBe(200)
      }
    } finally {
      for (const controller of controllers) controller.abort()
    }
  })

  it('evicts the oldest same-IP subscriber past the per-IP cap', async () => {
    await start()
    const first = await fetch(`${base}/api/events?token=${TOKEN}`, {
      headers: { accept: 'text/event-stream' }
    })
    expect(first.status).toBe(200)
    const firstBody = first.body
    if (!firstBody) throw new Error('expected a stream body')
    const reader = firstBody.getReader()
    const pending = reader.read()

    const holders: Response[] = []
    try {
      for (let i = 0; i < 4; i++) {
        const response = await fetch(`${base}/api/events?token=${TOKEN}`, {
          headers: { accept: 'text/event-stream' }
        })
        expect(response.status).toBe(200)
        holders.push(response)
      }
      // The fifth subscription evicts the first: its stream ends.
      const chunk = await pending
      expect(chunk.done).toBe(true)
    } finally {
      await reader.cancel()
      for (const response of holders) {
        try {
          await response.body?.cancel()
        } catch {
          // Already closed by eviction or shutdown.
        }
      }
    }
  })

  it('drops live subscriptions when their device is revoked', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Phone' })
    })
    const deviceToken = String(((await paired.json()) as { token?: unknown }).token)

    const events = await fetch(`${base}/api/events?token=${deviceToken}`, {
      headers: { accept: 'text/event-stream' }
    })
    expect(events.status).toBe(200)
    const body = events.body
    if (!body) throw new Error('expected a stream body')
    const pending = body.getReader().read()

    const [device] = server?.getDevices() ?? []
    expect(await server?.revokeDevice(device?.id ?? '')).toBe(true)

    const chunk = await pending
    expect(chunk.done).toBe(true)
  })

  it('serves the fingerprint publicly for trust binding', async () => {
    await start()

    // No credential needed: the fingerprint is TOFU material, not a secret.
    const response = await fetch(`${base}/api/fingerprint`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fingerprint: null })
  })

  it('issues a login cookie for the token and accepts it without any token', async () => {
    await start()

    const issued = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN })
    })
    expect(issued.status).toBe(200)
    const setCookie = issued.headers.get('set-cookie')
    expect(setCookie).toMatch(/^onda_session=[0-9a-f]{64}; HttpOnly; Path=\/; SameSite=Strict/)
    // Plain HTTP cannot set Secure — and sends no HSTS either.
    expect(setCookie).not.toContain('; Secure')
    expect(issued.headers.get('strict-transport-security')).toBeNull()
    const cookie = setCookie?.split(';')[0] ?? ''
    expect(savedSessions).toHaveLength(1)
    expect(savedSessions[0]?.id).toHaveLength(64)

    // The cookie alone authorizes: no bearer header, no query token anywhere.
    const library = await fetch(`${base}/api/library`, { headers: { cookie } })
    expect(library.status).toBe(200)
    expect(((await library.json()) as Record<string, unknown>)['trackCount']).toBe(2)
  })

  it('accepts a bearer credential for the session handshake', async () => {
    await start()

    const issued = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(issued.status).toBe(200)
    expect(issued.headers.get('set-cookie')).toContain('onda_session=')
  })

  it('rejects wrong tokens and forged cookies without setting one', async () => {
    await start()

    const wrong = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' })
    })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()

    const garbage = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json{{{'
    })
    expect(garbage.status).toBe(401)

    expect((await fetch(`${base}/api/library`, { headers: { cookie: 'onda_session=forged' } })).status).toBe(
      401
    )
    expect(savedSessions).toHaveLength(0)
  })

  it('rejects non-POST session requests', async () => {
    await start()

    expect((await fetch(`${base}/api/session?token=${TOKEN}`)).status).toBe(405)
  })

  it('pairs a device with a single-use code and accepts its token', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{9}$/)

    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: "Marco's phone" })
    })
    expect(paired.status).toBe(200)
    const body = (await paired.json()) as { token?: unknown }
    expect(typeof body.token).toBe('string')
    const deviceToken = String(body.token)
    expect(savedDevices).toHaveLength(1)
    expect(savedDevices[0]).toMatchObject({ name: "Marco's phone" })

    // The device token authorizes like the master, header or query.
    expect(
      (await fetch(`${base}/api/library`, { headers: { authorization: `Bearer ${deviceToken}` } })).status
    ).toBe(200)
    expect((await fetch(`${base}/api/library?token=${deviceToken}`)).status).toBe(200)

    // Single-use: the same code is dead now.
    const reuse = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Second' })
    })
    expect(reuse.status).toBe(401)
    expect(savedDevices).toHaveLength(1)
  })

  it('burns a displayed code so it cannot be redeemed', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    const pair = (): Promise<Response> =>
      fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name: 'Phone' })
      })

    expect(server?.burnPairingCode(code)).toBe(true)
    // Unknown and already-consumed codes are safe no-ops.
    expect(server?.burnPairingCode(code)).toBe(false)
    expect(server?.burnPairingCode('AAAAAAAAA')).toBe(false)

    expect((await pair()).status).toBe(401)
    expect(savedDevices).toHaveLength(0)
  })

  it('opens a session cookie for a paired device token', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Phone' })
    })
    const deviceToken = String(((await paired.json()) as { token?: unknown }).token)

    // A phone keeps only its device token: the handshake must accept it.
    const issued = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` }
    })
    expect(issued.status).toBe(200)
    const cookie = issued.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(200)
  })

    it('rejects bad codes, bad names, and non-POST pair requests', async () => {    await start()
    const pair = (payload: unknown): Promise<Response> =>
      fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload)
      })

    expect((await pair({ code: 'WRONGCODE', name: 'Phone' })).status).toBe(401)
    expect((await pair({ code: 'WRONGCODE', name: '' })).status).toBe(400)
    expect((await pair({ code: 'WRONGCODE' })).status).toBe(400)
    expect((await pair('not json{{{')).status).toBe(400)
    expect((await fetch(`${base}/api/pair`)).status).toBe(405)
    expect(savedDevices).toHaveLength(0)
  })

  it('revokes devices individually and drops them all on demand', async () => {
    await start()
    const first = server?.issuePairingCode() ?? { code: '' }
    const second = server?.issuePairingCode() ?? { code: '' }
    const pair = async (code: string, name: string): Promise<string> => {
      const response = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, name })
      })
      return String(((await response.json()) as { token?: unknown }).token)
    }
    const tokenA = await pair(first.code, 'Phone A')
    const tokenB = await pair(second.code, 'Phone B')
    const devices = server?.getDevices() ?? []
    expect(devices).toHaveLength(2)
    // Ids are opaque hashes, not the tokens themselves.
    for (const device of devices) {
      expect(device.id).toHaveLength(64)
      expect(device.id).not.toContain(tokenA)
    }

    const idA = devices.find((device) => device.name === 'Phone A')?.id ?? ''
    expect(await server?.revokeDevice(idA)).toBe(true)
    expect(await server?.revokeDevice('0'.repeat(64))).toBe(false)
    expect((await fetch(`${base}/api/library?token=${tokenA}`)).status).toBe(401)
    expect((await fetch(`${base}/api/library?token=${tokenB}`)).status).toBe(200)
    expect(savedDevices).toHaveLength(1)

    await server?.dropDevices()
    expect(savedDevices).toHaveLength(0)
    expect((await fetch(`${base}/api/library?token=${tokenB}`)).status).toBe(401)
    // The master token is unaffected by device drops.
    expect((await fetch(`${base}/api/library?token=${TOKEN}`)).status).toBe(200)
  })

  it('restores persisted devices across restarts', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Phone' })
    })
    const deviceToken = String(((await paired.json()) as { token?: unknown }).token)

    await server?.stop()
    await start([], savedDevices)
    expect((await fetch(`${base}/api/library?token=${deviceToken}`)).status).toBe(200)
  })

  it('restores persisted sessions and drops them on demand', async () => {
    await start()
    const issued = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const cookie = issued.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(200)

    // Restart with the persisted rows: the phone stays logged in.
    await server?.stop()
    await start(savedSessions)
    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(200)

    await server?.dropSessions()
    expect(savedSessions).toHaveLength(0)
    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(401)
  })

  it('expires sessions past their absolute or idle lifetime', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await start([
      { id: 'fresh', createdAt: now, lastSeen: now },
      { id: 'old-absolute', createdAt: now - 31 * day, lastSeen: now },
      { id: 'old-idle', createdAt: now, lastSeen: now - 8 * day }
    ])

    expect((await fetch(`${base}/api/library`, { headers: { cookie: 'onda_session=fresh' } })).status).toBe(
      200
    )
    expect(
      (await fetch(`${base}/api/library`, { headers: { cookie: 'onda_session=old-absolute' } })).status
    ).toBe(401)
    expect(
      (await fetch(`${base}/api/library`, { headers: { cookie: 'onda_session=old-idle' } })).status
    ).toBe(401)
  })

  it('expires idle devices, including at the session handshake', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await start(
      [],
      [{ token: 'stale-device', name: 'Old', createdAt: now - 100 * day, lastSeen: now - 91 * day }]
    )

    expect((await fetch(`${base}/api/library?token=stale-device`)).status).toBe(401)
    const handshake = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { authorization: 'Bearer stale-device' }
    })
    expect(handshake.status).toBe(401)
    expect(handshake.headers.get('set-cookie')).toBeNull()
  })

  it('logs out a session cookie and kills it', async () => {
    await start()
    const issued = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    const cookie = issued.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(200)

    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } })
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')

    expect((await fetch(`${base}/api/library`, { headers: { cookie } })).status).toBe(401)
    expect(savedSessions).toHaveLength(0)
  })

  it('logs out a device entirely by its bearer token', async () => {
    await start()
    const { code } = server?.issuePairingCode() ?? { code: '' }
    const paired = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: 'Phone' })
    })
    const deviceToken = String(((await paired.json()) as { token?: unknown }).token)

    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken}` }
    })
    expect(logout.status).toBe(200)

    expect((await fetch(`${base}/api/library?token=${deviceToken}`)).status).toBe(401)
    expect(savedDevices).toHaveLength(0)
  })

  it('leaves the master token alone on logout', async () => {
    await start()

    const logout = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    expect(logout.status).toBe(200)

    expect((await fetch(`${base}/api/library?token=${TOKEN}`)).status).toBe(200)
  })

  it('rejects logout without credentials or with GET', async () => {
    await start()

    expect((await fetch(`${base}/api/logout`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}/api/logout?token=${TOKEN}`)).status).toBe(405)
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

  it('refuses unknown ids, missing ids, and bad requests', async () => {    await start()
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

  it('refuses symlink escapes that sit lexically inside roots', async () => {
    // Directory junctions need no privileges even on Windows, so this is
    // real coverage everywhere: lexically inside the root, canonically out.
    const link = join(dir, 'jd')
    let planted = false
    for (const type of ['junction', 'dir'] as const) {
      try {
        await symlink(outside, link, type)
        planted = true
        break
      } catch {
        // No link privilege at all: the scan skip plus the canonical check
        // still cover escapes where links can be planted.
      }
    }
    if (!planted) return
    const escaped = join(link, 'secret.mp3')
    await start([], [], null, null, [escaped])
    const id = trackId(escaped)

    // Both doors stay shut for the escaped path.
    expect((await fetch(`${base}/api/stream?id=${id}&token=${TOKEN}`)).status).toBe(404)
    expect((await fetch(`${base}/api/cover?id=${id}&token=${TOKEN}`)).status).toBe(404)
  })

  it('serves embedded covers and 404s without art', async () => {    await start()
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

  it('refuses hostile cover types instead of reflecting them', async () => {
    const hostile = `data:text/html;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`
    await start([], [], null, () => Promise.resolve(hostile))
    const id = trackId(join(dir, 'song.mp3'))

    const response = await fetch(`${base}/api/cover?id=${id}&token=${TOKEN}`)
    expect(response.status).toBe(404)
  })

  it('serves allowed covers with anti-sniffing headers', async () => {
    await start()
    const artPath = join(dir, 'art.mp3')
    const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(417 - 4, 0)])
    await writeFile(artPath, Buffer.concat([NodeID3.create({ title: 'T' }), frame, frame]))
    const embedded = await writeTrackTags(artPath, {
      art: { mime: 'image/png', data: createPngBytes() }
    })
    expect(embedded.ok).toBe(true)

    const response = await fetch(`${base}/api/cover?id=${trackId(artPath)}&token=${TOKEN}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
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

  it('survives aborted streams and missing files mid-request', async () => {
    await start()
    const id = trackId(join(dir, 'song.mp3'))
    const url = `${base}/api/stream?id=${id}&token=${TOKEN}`

    const controller = new AbortController()
    const pending = fetch(url, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()

    // A file vanishing before the stat ends the request, not the process.
    await rm(join(dir, 'song.mp3'))
    expect((await fetch(url)).status).toBe(404)

    expect((await fetch(`${base}/api/library?token=${TOKEN}`)).status).toBe(200)
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

  it('reports plain HTTP without a certificate', async () => {
    await start()

    expect(server?.tlsStatus()).toEqual({ secure: false, fingerprint: null, expiresAt: null })
  })

  it('refuses to start certless without the insecure opt-in', async () => {
    const certless = createLibraryServer({
      getPort: () => 0,
      getToken: () => TOKEN,
      getTls: () => null,
      getAllowInsecure: () => false,
      getSessions: () => [],
      saveSessions: () => Promise.resolve(),
      getDevices: () => [],
      saveDevices: () => Promise.resolve(),
      getSummary: () => ({ tree: { artists: [], albums: [] }, tracks: [], trackCount: 0, roots: [], missingRoots: [], scanning: false }),
      readCover: () => Promise.resolve(null),
      getRoots: () => [],
      getClientDir: () => null
    })

    await expect(certless.start()).rejects.toThrow(/insecure fallback is off/)
    expect(certless.listening).toBe(false)
  })

  it('serves TLS with the configured certificate', async () => {
    const identity = await ensureServerCert(clientDir)
    await server?.stop()
    await start([], [], { cert: identity.cert, key: identity.key })
    const secureBase = base.replace('http://', 'https://')

    const status = server?.tlsStatus() ?? { secure: false, fingerprint: null, expiresAt: null }
    expect(status.secure).toBe(true)
    expect(status.fingerprint).toBe(identity.fingerprint)
    expect(status.expiresAt).toBe(identity.expiresAt)

    // Self-signed: the test client opts out of chain verification, exactly
    // like a phone does after confirming the fingerprint once.
    const response = await getInsecure(`${secureBase}/api/library?token=${TOKEN}`)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ trackCount: 2 })
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('marks the session cookie Secure over TLS', async () => {
    const identity = await ensureServerCert(clientDir)
    await server?.stop()
    await start([], [], { cert: identity.cert, key: identity.key })
    const secureBase = base.replace('http://', 'https://')

    const status = await new Promise<{ status: number; headers: string[] }>((resolve, reject) => {
      const request = httpsRequest(
        `${secureBase}/api/session`,
        {
          method: 'POST',
          rejectUnauthorized: false,
          headers: { authorization: `Bearer ${TOKEN}` }
        },
        (response) => {
          response.resume()
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: (response.headers['set-cookie'] as string[] | undefined) ?? []
            })
          )
          response.on('error', reject)
        }
      )
      request.on('error', reject)
      request.end()
    })

    expect(status.status).toBe(200)
    expect(status.headers.join(';')).toContain('; Secure')

    const cookie = (status.headers[0] ?? '').split(';')[0] ?? ''
    const logout = await new Promise<{ status: number; headers: string[] }>((resolve, reject) => {
      const request = httpsRequest(
        `${secureBase}/api/logout`,
        { method: 'POST', rejectUnauthorized: false, headers: { cookie } },
        (response) => {
          response.resume()
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: (response.headers['set-cookie'] as string[] | undefined) ?? []
            })
          )
          response.on('error', reject)
        }
      )
      request.on('error', reject)
      request.end()
    })

    expect(logout.status).toBe(200)
    expect(logout.headers.join(';')).toContain('; Secure')
  })
})
