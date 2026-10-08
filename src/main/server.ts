import { createReadStream, promises as fs } from 'node:fs'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import type { LibrarySummary, PublicLibrarySummary } from '@shared/ipc'
import type { DeviceInfo, DeviceRecord, ServerSession, Track } from '@shared/types'
import { extensionOf } from '@shared/audio-files'

export interface LibraryServerDeps {
  /** Read live so port changes apply without rebuilding the server. */
  getPort(): number
  getToken(): string | undefined
  /** TLS identity; null means plain HTTP (tests, or cert generation failed). */
  getTls(): { cert: string; key: string } | null
  /** Sessions persisted in config, so phones stay logged in across restarts. */
  getSessions(): readonly ServerSession[]
  /** Called whenever a session is issued; the whole config is rewritten. */
  saveSessions(sessions: readonly ServerSession[]): Promise<void>
  /** Paired devices, persisted alongside sessions. */
  getDevices(): readonly DeviceRecord[]
  /** Called on pair, revoke, drop, and throttled last-seen updates. */
  saveDevices(devices: readonly DeviceRecord[]): Promise<void>
  getSummary(): LibrarySummary
  readCover(path: string): Promise<string | null>
  getRoots(): readonly string[]
  /** Built renderer directory, or null when it was never built (dev mode). */
  getClientDir(): string | null
}

/** Short-lived single-use pairing code minted for the QR/link flow. */
export interface PairingCode {
  readonly code: string
  readonly expiresAt: number
}

export interface LibraryServer {
  readonly listening: boolean
  /** Resolves the reachable base URL, or rejects when the port is taken. */
  start(): Promise<string>
  stop(): Promise<void>
  /** Pushes the current summary to every SSE subscriber. */
  pushLibraryChanged(): void
  /** Whether clients are served over TLS, with the live cert's identity. */
  tlsStatus(): { secure: boolean; fingerprint: string | null; expiresAt: number | null }
  /** Forgets every issued session (token rotation); persisted too. */
  dropSessions(): Promise<void>
  /**
   * Mints a single-use pairing code. The code (not the master token) is what
   * the QR and copy-link carry, so the secret never leaves the desktop.
   */
  issuePairingCode(): PairingCode
  /** Paired devices for the desktop settings list. */
  getDevices(): DeviceInfo[]
  /** Revokes one device by its id; unknown ids report false. */
  revokeDevice(id: string): Promise<boolean>
  /**
   * Invalidates one outstanding pairing code (desktop hid its QR). Unknown
   * or already-consumed codes report false; both are safe no-ops.
   */
  burnPairingCode(code: string): boolean
  /** Forgets every device and pending code (token rotation); persisted too. */
  dropDevices(): Promise<void>
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.ape': 'audio/ape',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm'
}

/** First LAN IPv4, for the "open this on your phone" display. Loopback excluded. */
export function lanBaseUrl(port: number, secure = false): string | null {
  return lanBaseUrls(port, secure)[0] ?? null
}

/**
 * Every reachable LAN IPv4 base URL (loopback excluded): typically the home
 * LAN address plus the tailnet address when Tailscale runs. The desktop
 * settings screen lists them all so remote pairing picks the right one.
 */
export function lanBaseUrls(port: number, secure = false): string[] {
  const scheme = secure ? 'https' : 'http'
  const urls: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        const url = `${scheme}://${address.address}:${port}`
        if (!urls.includes(url)) urls.push(url)
      }
    }
  }
  return urls
}

/**
 * True when the requested path is a library root itself or lives under one.
 * relative() collapses `..` lexically, so anything escaping a root starts
 * with `..` (or resolves absolute on another drive) and is rejected.
 */
export function insideRoots(roots: readonly string[], candidate: string): boolean {
  const normalized = normalize(candidate)
  for (const root of roots) {
    const rel = relative(root, normalized)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * Opaque track id: a one-way hash of the absolute path. Deterministic, so it
 * survives rescans and restarts, and irreversible, so absolute paths (drives,
 * usernames, folder layout) never leave the machine. Remote clients use ids
 * everywhere local code uses paths.
 */
export function trackId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

const CLIENT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

/** Pinned inside the client dir: `..` collapses lexically, so escapes fail the prefix check. Exported for tests. */
export function clientPathIn(clientDir: string, requestPath: string): string | null {
  // resolve() absolutizes and normalizes both sides alike, so a relative base
  // and mixed separators compare correctly on every platform.
  const base = resolve(clientDir)
  const resolved = resolve(base, `.${requestPath}`)
  // The separator-joined prefix keeps a sibling like `<dir>-other` out.
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) return null
  return resolved
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

/** Login cookie name. HttpOnly so page JS can never steal it; SameSite=Strict
 * so cross-site pages cannot ride it. (`Secure` arrives with TLS in Phase 3 —
 * plain HTTP on the LAN cannot set it.) */
const SESSION_COOKIE = 'onda_session'
/** Browser keeps the login ~a year; the server itself never expires sessions. */
const SESSION_MAX_AGE = 31536000
/** Session handshake bodies are tiny JSON; anything bigger is abuse. */
const SESSION_BODY_LIMIT = 4096

/** Null unless the request carries a syntactically valid session id. */
function sessionIdOf(request: IncomingMessage): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) continue
    const value = trimmed.slice(SESSION_COOKIE.length + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/** Reads a small request body, or null when it is missing, oversized, or unreadable. */
function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (body: string | null): void => {
      if (done) return
      done = true
      resolve(body)
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => finish(null))
  })
}

export function createLibraryServer(deps: LibraryServerDeps): LibraryServer {
  let server: Server | HttpsServer | null = null
  let listening = false
  let boundPort = 0
  const events = new Set<ServerResponse>()
  // Opaque id → real path, rebuilt only when the track list itself is replaced
  // (i.e. on rescan); lookups in between are map hits.
  let idCache: { tracks: readonly Track[]; byId: Map<string, string> } | null = null
  // Issued session id → creation time. Seeded from persisted config at
  // startup; every issue persists, so restarts keep phones logged in.
  const sessions = new Map<string, number>(
    deps.getSessions().map((session) => [session.id, session.createdAt])
  )

  async function persistSessions(): Promise<void> {
    const rows: ServerSession[] = [...sessions].map(([id, createdAt]) => ({ id, createdAt }))
    await deps.saveSessions(rows)
  }

  // Device token → record. Seeded from persisted config; membership changes
  // (pair, revoke, drop) persist immediately, while last-seen activity
  // persists throttled so every request does not rewrite the config file.
  // Mutable internally; snapshots go out through persistDevices/getDevices.
  interface StoredDevice {
    token: string
    name: string
    createdAt: number
    lastSeen: number
  }
  const devices = new Map<string, StoredDevice>(
    deps.getDevices().map((device) => [device.token, { ...device }])
  )
  let lastDevicesPersist = 0

  async function persistDevices(): Promise<void> {
    lastDevicesPersist = Date.now()
    await deps.saveDevices([...devices.values()])
  }

  // Outstanding pairing codes → creation time. In-memory only: a restart
  // invalidates a displayed QR, and the desktop simply mints a fresh one.
  const pairings = new Map<string, number>()

  /** Opaque device id for the settings UI: identifies for revoke, useless for login. */
  function deviceId(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex')
  }

  /** Pairing codes live 10 minutes and are typed by hand as a fallback, so the
   * alphabet skips ambiguous characters (0/O, 1/I/L). 9 chars ≈ 45 bits —
   * far past online guessing inside a 10-minute single-use window. */
  const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
  const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

  function sweepPairings(now: number = Date.now()): void {
    for (const [code, issuedAt] of pairings) {
      if (now - issuedAt > PAIRING_CODE_TTL_MS) pairings.delete(code)
    }
    // A stuck-open QR screen must not accumulate codes without bound.
    while (pairings.size > 10) {
      const oldest = pairings.keys().next()
      if (oldest.done) break
      pairings.delete(oldest.value)
    }
  }

  function resolveTrackId(id: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null
    const tracks = deps.getSummary().tracks
    if (!idCache || idCache.tracks !== tracks) {
      const byId = new Map<string, string>()
      for (const track of tracks) byId.set(trackId(track.path), track.path)
      idCache = { tracks, byId }
    }
    return idCache.byId.get(id) ?? null
  }

  function publicSummary(): PublicLibrarySummary {
    const summary = deps.getSummary()
    const idByPath = new Map<string, string>()
    const idOf = (path: string): string => {
      const existing = idByPath.get(path)
      if (existing) return existing
      const id = trackId(path)
      idByPath.set(path, id)
      return id
    }
    return {
      tree: {
        artists: summary.tree.artists,
        albums: summary.tree.albums.map((album) => ({
          ...album,
          trackPaths: album.trackPaths.map(idOf)
        }))
      },
      tracks: summary.tracks.map((track) => ({ ...track, path: idOf(track.path) })),
      trackCount: summary.trackCount,
      scanning: summary.scanning
    }
  }

/** Which credential authorized a request; null when none did. */
type AuthResult = { kind: 'master' } | { kind: 'session' } | { kind: 'device'; token: string } | null

  function authorized(request: IncomingMessage, url: URL): AuthResult {
    const token = deps.getToken()
    if (!token) return null
    const header = request.headers.authorization
    const presented = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : (url.searchParams.get('token') ?? null)
    if (presented === null) {
      // The login cookie is the preferred credential: unlike the query token
      // it never lands in logs, history, or referrers, and <audio>/<img>/
      // EventSource send it automatically on same-origin requests.
      const sessionId = sessionIdOf(request)
      return sessionId && sessions.has(sessionId) ? { kind: 'session' } : null
    }
    if (presented === token) return { kind: 'master' }
    // <audio> and <img> tags cannot set headers, so media URLs carry the
    // credential instead — a device token works there exactly like the master.
    if (devices.has(presented)) return { kind: 'device', token: presented }
    return null
  }

  /**
   * POST /api/session: trades the token (bearer header or JSON body, never
   * the URL) for an HttpOnly login cookie. A wrong token gets a bare 401 —
   * no cookie, no hint.
   */
  async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = deps.getToken()
    const header = request.headers.authorization
    const presented =
      header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
    let bodyToken: string | null = null
    if (presented === null) {
      const raw = await readBody(request, SESSION_BODY_LIMIT)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          bodyToken = typeof parsed['token'] === 'string' ? parsed['token'] : null
        } catch {
          bodyToken = null
        }
      }
    }
    const credential = presented ?? bodyToken
    // The master token logs in, and so does any paired device token — a phone
    // that paired yesterday must be able to open a session with the only
    // credential it kept.
    const known = token !== undefined && (credential === token || (credential !== null && devices.has(credential)))
    if (!token || !known) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    const id = randomBytes(32).toString('hex')
    sessions.set(id, Date.now())
    await persistSessions()
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`
    })
    response.end(JSON.stringify({ ok: true }))
  }

  /**
   * POST /api/pair: trades a single-use pairing code (from the desktop QR or
   * link) plus a device name for that device's own token. The code is
   * consumed on success; a wrong code gets a bare 401 that reveals nothing.
   */
  async function handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    sweepPairings()
    const raw = await readBody(request, SESSION_BODY_LIMIT)
    let code: unknown = null
    let name: unknown = null
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        code = parsed['code']
        name = parsed['name']
      } catch {
        code = null
      }
    }
    const trimmedName = typeof name === 'string' ? name.trim() : ''
    if (trimmedName === '' || trimmedName.length > 64) {
      json(response, 400, { error: 'a device name up to 64 characters is required' })
      return
    }
    const issuedAt = typeof code === 'string' ? pairings.get(code) : undefined
    if (typeof code !== 'string' || issuedAt === undefined) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    pairings.delete(code)
    const token = randomBytes(32).toString('hex')
    const now = Date.now()
    devices.set(token, { token, name: trimmedName, createdAt: now, lastSeen: now })
    await persistDevices()
    json(response, 200, { token })
  }

  async function serveStream(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let size: number
    try {
      const stats = await fs.stat(path)
      if (!stats.isFile()) {
        json(response, 404, { error: 'not an audio file' })
        return
      }
      size = stats.size
    } catch {
      json(response, 404, { error: 'not found' })
      return
    }

    const mime = AUDIO_MIME[extensionOf(path)] ?? 'application/octet-stream'
    const range = request.headers.range
    if (!range) {
      response.writeHead(200, {
        'content-type': mime,
        'content-length': size,
        'accept-ranges': 'bytes'
      })
      createReadStream(path).pipe(response)
      return
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match) {
      response.writeHead(416, { 'content-range': `bytes */${size}` })
      response.end()
      return
    }
    const startText = match[1]
    const endText = match[2]
    let start: number
    let end: number
    if (startText === '') {
      // Suffix range: the last N bytes.
      const count = Number(endText)
      if (endText === '' || !Number.isFinite(count) || count <= 0) {
        response.writeHead(416, { 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      start = Math.max(0, size - Math.trunc(count))
      end = size - 1
    } else {
      start = Number(startText)
      end = endText === '' ? size - 1 : Number(endText)
      if (!Number.isFinite(start) || start < 0 || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      if (!Number.isFinite(end) || end < start) end = size - 1
      if (end >= size) end = size - 1
    }

    response.writeHead(206, {
      'content-type': mime,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes'
    })
    createReadStream(path, { start, end }).pipe(response)
  }

  async function serveCover(path: string, response: ServerResponse): Promise<void> {
    const dataUrl = await deps.readCover(path)
    const parsed = dataUrl ? /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl) : null
    if (!parsed?.[1] || !parsed[2]) {
      json(response, 404, { error: 'no cover art' })
      return
    }
    const bytes = Buffer.from(parsed[2], 'base64')
    response.writeHead(200, { 'content-type': parsed[1], 'content-length': bytes.length })
    response.end(bytes)
  }

  async function serveClient(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const clientDir = deps.getClientDir()
    if (!clientDir) {
      json(response, 404, { error: 'client not built' })
      return
    }
    const sendFile = async (file: string, noStore: boolean): Promise<void> => {
      const headers: Record<string, string> = {
        'content-type': CLIENT_MIME[extensionOf(file)] ?? 'application/octet-stream'
      }
      if (noStore) headers['cache-control'] = 'no-store'
      try {
        const stats = await fs.stat(file)
        if (!stats.isFile()) throw new Error('not a file')
        headers['content-length'] = String(stats.size)
        response.writeHead(200, headers)
        createReadStream(file).pipe(response)
      } catch {
        json(response, 404, { error: 'not found' })
      }
    }
    if (pathname === '/' || pathname === '/index.html') {
      await sendFile(resolve(clientDir, 'index.html'), true)
      return
    }
    const file = clientPathIn(clientDir, pathname)
    if (!file) {
      json(response, 404, { error: 'not found' })
      return
    }
    try {
      const stats = await fs.stat(file)
      if (stats.isFile()) {
        await sendFile(file, false)
        return
      }
    } catch {
      // Missing below: fall through to the SPA fallback when appropriate.
    }
    // Single-page app: navigations outside /api/* load the shell, which routes
    // client-side. Asset-looking misses 404 so stale bundles fail loudly.
    const acceptsHtml = (request.headers.accept ?? '').includes('text/html')
    if (acceptsHtml) {
      await sendFile(resolve(clientDir, 'index.html'), true)
      return
    }
    json(response, 404, { error: 'not found' })
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    // The session handshake is the only POST: it must come before the
    // GET-only gate below, and it answers 405 to anything else.
    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        await handleSession(request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'request failed' })
        else response.end()
      }
      return
    }
    // Pairing consumes its credential instead of presenting one, so like the
    // handshake it sits outside the auth gate — with the same 405 discipline.
    if (url.pathname === '/api/pair') {
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        await handlePair(request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'request failed' })
        else response.end()
      }
      return
    }
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    // The UI shell is public: a phone must load the page to enter its token.
    // Everything under /api/* requires the token instead.
    if (!url.pathname.startsWith('/api/')) {
      try {
        await serveClient(url.pathname, request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'request failed' })
        else response.end()
      }
      return
    }
    const auth = authorized(request, url)
    if (!auth) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    if (auth.kind === 'device') {
      // Fresh activity for the settings list, persisted throttled so routine
      // requests do not rewrite the config file every time.
      const record = devices.get(auth.token)
      if (!record) {
        json(response, 401, { error: 'unauthorized' })
        return
      }
      record.lastSeen = Date.now()
      if (Date.now() - lastDevicesPersist > 60 * 1000) {
        try {
          await persistDevices()
        } catch {
          // Activity bookkeeping must never fail a media request.
        }
      }
    }

    if (url.pathname === '/api/library') {
      json(response, 200, publicSummary())
      return
    }
    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.flushHeaders()
      events.add(response)
      request.on('close', () => {
        events.delete(response)
      })
      return
    }
    if (url.pathname === '/api/stream' || url.pathname === '/api/cover') {
      const id = url.searchParams.get('id')
      if (!id) {
        json(response, 400, { error: 'missing id' })
        return
      }
      // Opaque ids cannot traverse by construction; the resolved real path is
      // still containment-checked as defense in depth.
      const real = resolveTrackId(id)
      if (!real || !insideRoots(deps.getRoots(), real)) {
        json(response, 404, { error: 'not found' })
        return
      }
      try {
        if (url.pathname === '/api/cover') await serveCover(real, response)
        else await serveStream(real, request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'stream failed' })
        else response.end()
      }
      return
    }
    json(response, 404, { error: 'unknown endpoint' })
  }

  return {
    get listening() {
      return listening
    },

    start(): Promise<string> {
      const scheme = deps.getTls() ? 'https' : 'http'
      if (server) return Promise.resolve(`${scheme}://localhost:${boundPort}`)
      return new Promise((resolve, reject) => {
        // HTTPS when a certificate is available (production), plain HTTP
        // otherwise (tests, or cert generation failed at enable time).
        const tls = deps.getTls()
        const next = tls
          ? createHttpsServer({ cert: tls.cert, key: tls.key }, (request, response) => {
              void handle(request, response)
            })
          : createServer((request, response) => {
              void handle(request, response)
            })
        next.on('error', (error: unknown) => {
          reject(error instanceof Error ? error : new Error('server failed to start'))
        })
        next.listen(deps.getPort(), '0.0.0.0', () => {
          server = next
          listening = true
          const address = next.address()
          boundPort = typeof address === 'object' && address ? address.port : deps.getPort()
          resolve(`${scheme}://localhost:${boundPort}`)
        })
      })
    },

    stop(): Promise<void> {
      for (const client of events) {
        try {
          client.end()
        } catch {
          // A dead subscriber must never block shutdown.
        }
      }
      events.clear()
      const closing = server
      server = null
      listening = false
      boundPort = 0
      if (!closing) return Promise.resolve()
      return new Promise((resolve) => closing.close(() => resolve()))
    },

    pushLibraryChanged(): void {
      if (events.size === 0) return
      const payload = `data: ${JSON.stringify(publicSummary())}\n\n`
      for (const client of [...events]) {
        try {
          client.write(payload)
        } catch {
          events.delete(client)
        }
      }
    },

    tlsStatus(): { secure: boolean; fingerprint: string | null; expiresAt: number | null } {
      const tls = listening ? deps.getTls() : null
      if (!tls) return { secure: false, fingerprint: null, expiresAt: null }
      try {
        const certificate = new X509Certificate(tls.cert)
        const expiresAt = Date.parse(certificate.validTo)
        return {
          secure: true,
          fingerprint: certificate.fingerprint256,
          expiresAt: Number.isFinite(expiresAt) ? expiresAt : null
        }
      } catch {
        return { secure: true, fingerprint: null, expiresAt: null }
      }
    },

    async dropSessions(): Promise<void> {
      sessions.clear()
      await persistSessions()
    },

    issuePairingCode(): PairingCode {
      sweepPairings()
      const bytes = randomBytes(9)
      let code = ''
      for (const byte of bytes) {
        const char = PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
        code += char ?? ''
      }
      const now = Date.now()
      pairings.set(code, now)
      return { code, expiresAt: now + PAIRING_CODE_TTL_MS }
    },

    getDevices(): DeviceInfo[] {
      return [...devices.values()].map((record) => ({
        id: deviceId(record.token),
        name: record.name,
        createdAt: record.createdAt,
        lastSeen: record.lastSeen
      }))
    },

    async revokeDevice(id: string): Promise<boolean> {
      for (const [token] of devices) {
        if (deviceId(token) === id) {
          devices.delete(token)
          await persistDevices()
          return true
        }
      }
      return false
    },

    burnPairingCode(code: string): boolean {
      return pairings.delete(code)
    },

    async dropDevices(): Promise<void> {
      devices.clear()
      pairings.clear()
      await persistDevices()
    }
  }
}
