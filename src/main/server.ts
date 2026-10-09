import { createReadStream, promises as fs } from 'node:fs'
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { networkInterfaces } from 'node:os'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import type { LibrarySummary, PublicLibrarySummary } from '@shared/ipc'
import type { DeviceInfo, DeviceRecord, ServerSession, Track } from '@shared/types'
import { extensionOf } from '@shared/audio-files'
import { ALLOWED_COVER_MIME, MAX_COVER_BYTES } from './library/covers'

export interface LibraryServerDeps {
  /** Read live so port changes apply without rebuilding the server. */
  getPort(): number
  getToken(): string | undefined
  /** TLS identity; null means plain HTTP (tests, or cert generation failed). */
  getTls(): { cert: string; key: string } | null
  /** Explicit user opt-in to the plain-HTTP fallback; start() enforces it. */
  getAllowInsecure(): boolean
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

export type ServerTransport = 'https' | 'http' | 'disabled'

/**
 * Fail closed: without a certificate the server only listens with explicit
 * user opt-in (`allowInsecure`). Callers gate `start()` on this — the server
 * itself still serves whatever identity it is given.
 */
export function selectServerTransport(
  tls: { cert: string; key: string } | null,
  allowInsecure: boolean
): ServerTransport {
  if (tls) return 'https'
  return allowInsecure ? 'http' : 'disabled'
}

/**
 * True when the requested path is a library root itself or lives under one.
 * relative() collapses `..` lexically, so anything escaping a root starts
 * with `..` (or resolves absolute on another drive) and is rejected.
 * Case folds on Windows, where the filesystem itself is case-insensitive.
 */
export function insideRoots(roots: readonly string[], candidate: string): boolean {
  const fold = process.platform === 'win32'
  const normalized = fold ? normalize(candidate).toLowerCase() : normalize(candidate)
  for (const root of roots) {
    const base = fold ? normalize(root).toLowerCase() : root
    const rel = relative(base, normalized)
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

/**
 * Handshake endpoints (`/api/session`, `/api/pair`) accept secrets, so they
 * get a per-IP token bucket: 10 attempts per minute, then 429. The secrets
 * themselves are unguessable (256-bit tokens, 45-bit single-use codes), so
 * this is a backstop against scripting and socket-hoarding, not the primary
 * defense. State lives per server instance and resets on restart.
 */
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60_000

function handshakeAllowed(
  seen: Map<string, { count: number; resetAt: number }>,
  request: IncomingMessage,
  now: number = Date.now()
): { ok: true } | { ok: false; retryAfterSec: number } {
  // One bucket per peer: fold IPv6-mapped IPv4 (`::ffff:1.2.3.4`) onto the
  // address it is, or one stack split-brains the limit.
  const ip = bucketIp(request)
  if (seen.size > 1024) {
    for (const [key, entry] of seen) {
      if (now >= entry.resetAt) seen.delete(key)
    }
  }
  const entry = seen.get(ip)
  if (!entry || now >= entry.resetAt) {
    seen.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { ok: true }
  }
  entry.count += 1
  if (entry.count > RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }
  return { ok: true }
}

/** Slowloris guard: headers must arrive promptly; bodies stream without a cap (media). */
const HEADERS_TIMEOUT_MS = 10_000
/** Upper bound on request headers; the API needs a handful. */
const MAX_HEADER_COUNT = 100
/** Live event subscribers; beyond this the server answers 503. */
const MAX_EVENT_SUBSCRIBERS = 20
/** Per-IP subscriber cap: one peer cannot hoard the global budget. */
const MAX_EVENT_SUBSCRIBERS_PER_IP = 4
/** SSE keepalive: NATs and proxies drop idle sockets the client cannot see. */
const EVENT_HEARTBEAT_MS = 25_000

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

/** Rate-limit (and subscriber) bucket key for a peer. Exported for tests. */
export function bucketIp(request: Pick<IncomingMessage, 'socket'>): string {
  const raw = request.socket.remoteAddress ?? 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw
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
      clearTimeout(timer)
      resolve(body)
    }
    // A dripped body must not idle forever: 10 seconds for 4 KB is generous
    // to slow phones and fatal to slow-drip scripts.
    const timer = setTimeout(() => {
      request.destroy()
      finish(null)
    }, 10_000)
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
  /**
   * Live event subscribers with the credential that opened them. Checked on
   * every heartbeat and dropped proactively on revoke, so an expired or
   * revoked phone stops receiving library pushes — revocation takes effect
   * on open channels, not just new requests.
   */
  interface EventSubscriber {
    response: ServerResponse
    ip: string
    auth: Exclude<AuthResult, null>
  }
  const events = new Set<EventSubscriber>()
  // Opaque id → real path, rebuilt only when the track list itself is replaced
  // (i.e. on rescan); lookups in between are map hits.
  let idCache: { tracks: readonly Track[]; byId: Map<string, string> } | null = null
  // Issued session id → record. Seeded from persisted config at startup;
  // every issue persists, so restarts keep phones logged in. Expired entries
  // die lazily on use (plus a sweep on issue) and persist throttled.
  const sessions = new Map<string, { createdAt: number; lastSeen: number }>(
    deps.getSessions().map((session) => [session.id, { createdAt: session.createdAt, lastSeen: session.lastSeen }])
  )
  let sessionsDirty = false
  let lastSessionsPersist = 0

  async function persistSessions(): Promise<void> {
    lastSessionsPersist = Date.now()
    const rows: ServerSession[] = [...sessions].map(([id, record]) => ({
      id,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen
    }))
    await deps.saveSessions(rows)
  }

  /**
   * Writes dirty session/device stores, throttled so routine activity does
   * not rewrite the config file on every request. Bookkeeping must never
   * fail a media request, so persistence failures are swallowed here.
   */
  async function flushDirtyStores(): Promise<void> {
    const now = Date.now()
    if (sessionsDirty && now - lastSessionsPersist > 60 * 1000) {
      sessionsDirty = false
      try {
        await persistSessions()
      } catch {
        // Best effort, as above.
      }
    }
    if (devicesDirty && now - lastDevicesPersist > 60 * 1000) {
      devicesDirty = false
      try {
        await persistDevices()
      } catch {
        // Best effort, as above.
      }
    }
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
  let devicesDirty = false

  async function persistDevices(): Promise<void> {
    lastDevicesPersist = Date.now()
    await deps.saveDevices([...devices.values()])
  }

  // Outstanding pairing codes → creation time. In-memory only: a restart
  // invalidates a displayed QR, and the desktop simply mints a fresh one.
  const pairings = new Map<string, number>()
  // Handshake attempts per IP for the token bucket above. Never persisted.
  const handshakeAttempts = new Map<string, { count: number; resetAt: number }>()
  // SSE keepalive timer; owned by start()/stop() like the socket itself.
  let heartbeat: NodeJS.Timeout | null = null

  /** Live TLS identity for status surfaces; nulls when not serving HTTPS. */
  function liveTlsStatus(): { secure: boolean; fingerprint: string | null; expiresAt: number | null } {
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
  }

  /** Ends and forgets every subscriber matching a predicate (revocation). */
  function dropSubscribers(predicate: (sub: EventSubscriber) => boolean): void {
    for (const sub of [...events]) {
      if (!predicate(sub)) continue
      events.delete(sub)
      try {
        sub.response.end()
      } catch {
        // Already gone; the set removal is what matters.
      }
    }
  }

  /** True while the credential behind a subscription still authorizes. */
  function subscriberAlive(sub: EventSubscriber, now: number = Date.now()): boolean {
    if (sub.auth.kind === 'master') {
      const token = deps.getToken()
      return token !== undefined && secretsEqual(sub.auth.token, token)
    }
    if (sub.auth.kind === 'session') {
      const session = sessions.get(sub.auth.id)
      if (!session || !sessionAlive(session, now)) {
        if (session) {
          sessions.delete(sub.auth.id)
          sessionsDirty = true
        }
        return false
      }
      return true
    }
    return takeLiveDevice(sub.auth.token, now) !== null
  }

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
type AuthResult =
  | { kind: 'master'; token: string }
  | { kind: 'session'; id: string }
  | { kind: 'device'; token: string }
  | null

/**
 * Lifetimes: sessions die 30 days after issue no matter what, or after 7
 * idle days; devices die after 90 idle days with no absolute cap (re-pairing
 * is user-visible friction, rotation covers emergencies). Abandoned phones
 * fall off by themselves; active ones never notice.
 */
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEVICE_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000

function sessionAlive(session: { createdAt: number; lastSeen: number }, now: number): boolean {
  return now - session.createdAt <= SESSION_ABSOLUTE_TTL_MS && now - session.lastSeen <= SESSION_IDLE_TTL_MS
}

function deviceAlive(record: { lastSeen: number }, now: number): boolean {
  return now - record.lastSeen <= DEVICE_IDLE_TTL_MS
}

/**
 * Constant-time string compare for secrets. Map lookups stay hash-based;
 * the bearer secret — the one an oracle could target — gets no shortcut.
 */
function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}
  /**
   * Returns the live device record for a presented token, or null. Expired
   * records are deleted on sight (persisted throttled), so a phone idle past
   * its window is logged out the next time it knocks.
   */
  function takeLiveDevice(token: string, now: number): StoredDevice | null {
    const record = devices.get(token)
    if (!record) return null
    if (!deviceAlive(record, now)) {
      devices.delete(token)
      devicesDirty = true
      return null
    }
    return record
  }

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
      if (sessionId) {
        const session = sessions.get(sessionId)
        if (session) {
          if (!sessionAlive(session, Date.now())) {
            sessions.delete(sessionId)
            sessionsDirty = true
            return null
          }
          return { kind: 'session', id: sessionId }
        }
      }
      return null
    }
    if (secretsEqual(presented, token)) return { kind: 'master', token: presented }
    // <audio> and <img> tags cannot set headers, so media URLs carry the
    // credential instead — a device token works there exactly like the master.
    const record = takeLiveDevice(presented, Date.now())
    return record ? { kind: 'device', token: presented } : null
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
    // credential it kept. An idle-expired device cannot mint sessions.
    const known =
      token !== undefined &&
      credential !== null &&
      (secretsEqual(credential, token) || takeLiveDevice(credential, Date.now()) !== null)
    if (!token || !known) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    // Reap expired sessions with the issue so the store cannot grow stale
    // entries without bound; the persist below writes the swept set.
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (!sessionAlive(session, now)) sessions.delete(id)
    }
    sessionsDirty = false
    const id = randomBytes(32).toString('hex')
    sessions.set(id, { createdAt: now, lastSeen: now })
    await persistSessions()
    // An expired device knocking above was just reaped in memory; write that
    // through now rather than leaving the corpse in config.
    if (devicesDirty) {
      devicesDirty = false
      try {
        await persistDevices()
      } catch {
        // Best effort: the in-memory delete is what authorizes.
      }
    }
    // `Secure` only when the transport is TLS — plain HTTP cannot set it,
    // and a cookie without it never leaves a secure origin anyway.
    const cookieSecure = deps.getTls() ? '; Secure' : ''
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${cookieSecure}`
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
      pipeFile(path, null, request, response)
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
    pipeFile(path, { start, end }, request, response)
  }

  /**
   * Pipes a file to the response without letting filesystem races crash the
   * main process: a file deleted or locked mid-stream ends the response
   * instead of throwing uncaught, and a dropped client destroys the stream
   * instead of leaking its handle.
   */
  function pipeFile(
    path: string,
    options: { start: number; end: number } | null,
    request: IncomingMessage,
    response: ServerResponse
  ): void {
    const stream = options ? createReadStream(path, options) : createReadStream(path)
    stream.on('error', () => {
      if (!response.headersSent) json(response, 500, { error: 'stream failed' })
      else response.end()
    })
    request.on('close', () => stream.destroy())
    stream.pipe(response)
  }

  async function serveCover(path: string, response: ServerResponse): Promise<void> {
    const dataUrl = await deps.readCover(path)
    const parsed = dataUrl ? /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl) : null
    // Defense in depth: extraction already filters, but a hostile MIME must
    // never reach the wire even if a future reader is lax. Non-images 404.
    const mime = parsed?.[1]?.toLowerCase().trim() ?? ''
    if (!parsed?.[2] || !ALLOWED_COVER_MIME.has(mime)) {
      json(response, 404, { error: 'no cover art' })
      return
    }
    const bytes = Buffer.from(parsed[2], 'base64')
    if (bytes.length > MAX_COVER_BYTES) {
      json(response, 404, { error: 'no cover art' })
      return
    }
    response.writeHead(200, {
      'content-type': mime,
      'content-length': bytes.length,
      // Even an allowed image must not sniff or script: a direct navigation
      // to this URL renders in server origin.
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      'referrer-policy': 'no-referrer'
    })
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
        pipeFile(file, null, request, response)
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
    // Pinned before any routing: tampering with transport security must not
    // depend on which endpoint answers.
    if (deps.getTls()) {
      response.setHeader('strict-transport-security', 'max-age=31536000')
    }
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('cross-origin-resource-policy', 'same-origin')
    // Public identity: the fingerprint is trust-on-first-use material, not a
    // secret (browsers display it), so phones can bind saved trust to it —
    // no credential required, like the client shell below.
    if (url.pathname === '/api/fingerprint') {
      if (request.method !== 'GET') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      json(response, 200, { fingerprint: liveTlsStatus().fingerprint })
      return
    }
    // Logout revokes its own credential, so it authenticates inline here
    // rather than behind the GET-only gate below. A session dies with its
    // cookie, a device dies entirely; the master token has no per-login
    // state (rotating it is its logout), so it just clears the cookie.
    if (url.pathname === '/api/logout') {
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      const auth = authorized(request, url)
      if (!auth) {
        json(response, 401, { error: 'unauthorized' })
        return
      }
      try {
        if (auth.kind === 'session') {
          sessions.delete(auth.id)
          await persistSessions()
        } else if (auth.kind === 'device') {
          devices.delete(auth.token)
          await persistDevices()
        }
      } catch {
        // The cookie clearing below still logs the browser out; the
        // in-memory deletes are what authorize.
      }
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // Mirror the login cookie's flags exactly, or strict browsers keep
        // the (revoked) Secure cookie this is meant to clear.
        'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${deps.getTls() ? '; Secure' : ''}`
      })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    // The session handshake is the only POST: it must come before the
    // GET-only gate below, and it answers 405 to anything else.
    if (url.pathname === '/api/session') {
      if (request.method !== 'POST') {
        json(response, 405, { error: 'method not allowed' })
        return
      }
      const sessionLimit = handshakeAllowed(handshakeAttempts, request)
      if (!sessionLimit.ok) {
        response.setHeader('retry-after', String(sessionLimit.retryAfterSec))
        json(response, 429, { error: 'too many attempts' })
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
      const pairLimit = handshakeAllowed(handshakeAttempts, request)
      if (!pairLimit.ok) {
        response.setHeader('retry-after', String(pairLimit.retryAfterSec))
        json(response, 429, { error: 'too many attempts' })
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
    // Fresh activity slides both idle windows, persisted throttled so
    // routine requests do not rewrite the config file every time. Records
    // were liveness-checked in authorized(), so the lookups cannot miss.
    if (auth.kind === 'device') {
      const record = devices.get(auth.token)
      if (record) {
        record.lastSeen = Date.now()
        devicesDirty = true
      }
    }
    if (auth.kind === 'session') {
      const session = sessions.get(auth.id)
      if (session) {
        session.lastSeen = Date.now()
        sessionsDirty = true
      }
    }
    await flushDirtyStores()

    if (url.pathname === '/api/library') {
      json(response, 200, publicSummary())
      return
    }
    if (url.pathname === '/api/events') {
      // Bounded subscribers: an unbounded Set lets one peer hoard sockets.
      if (events.size >= MAX_EVENT_SUBSCRIBERS) {
        json(response, 503, { error: 'too many subscribers' })
        return
      }
      const subscriberIp = bucketIp(request)
      // Per-IP cap with oldest-first eviction: a reconnect storm from one
      // peer (each EventSource retry opens a new socket while the old one
      // lingers) must not deny live-updates to everyone else.
      const sameIp = [...events].filter((sub) => sub.ip === subscriberIp)
      if (sameIp.length >= MAX_EVENT_SUBSCRIBERS_PER_IP) {
        const oldest = sameIp[0]
        if (oldest) {
          events.delete(oldest)
          try {
            oldest.response.end()
          } catch {
            // Already gone; the set removal is what matters.
          }
        }
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.flushHeaders()
      const subscriber: EventSubscriber = { response, ip: subscriberIp, auth }
      events.add(subscriber)
      request.on('close', () => {
        events.delete(subscriber)
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
      // still containment-checked as defense in depth — twice: lexically,
      // then canonically, so a symlink planted in the library cannot smuggle
      // an outside file past the check (TOCTOU included: the canonical path
      // is what actually gets served).
      const real = resolveTrackId(id)
      if (!real || !insideRoots(deps.getRoots(), real)) {
        json(response, 404, { error: 'not found' })
        return
      }
      let canonical: string
      try {
        canonical = await fs.realpath(real)
        const canonicalRoots: string[] = []
        for (const root of deps.getRoots()) {
          try {
            canonicalRoots.push(await fs.realpath(root))
          } catch {
            // Unreachable roots cannot contain anything right now.
          }
        }
        if (!insideRoots(canonicalRoots, canonical)) throw new Error('outside roots')
      } catch {
        json(response, 404, { error: 'not found' })
        return
      }
      try {
        if (url.pathname === '/api/cover') await serveCover(canonical, response)
        else await serveStream(canonical, request, response)
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
      const tls = deps.getTls()
      const scheme = tls ? 'https' : 'http'
      if (server) return Promise.resolve(`${scheme}://localhost:${boundPort}`)
      // Fail-closed is enforced here, not just in callers: without an
      // identity the server only listens with explicit user opt-in.
      if (selectServerTransport(tls, deps.getAllowInsecure()) === 'disabled') {
        return Promise.reject(new Error('server has no certificate and insecure fallback is off'))
      }
      return new Promise((resolve, reject) => {
        // HTTPS when a certificate is available (production), plain HTTP
        // otherwise (tests, or cert generation failed at enable time).
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
        // Slowloris guard on the header phase; bodies stream uncapped (media).
        // requestTimeout stays default: SSE responses never complete, and
        // EventSource reconnects transparently if one is ever cut.
        next.headersTimeout = HEADERS_TIMEOUT_MS
        next.maxHeadersCount = MAX_HEADER_COUNT
        // SSE keepalive: NATs silently drop idle sockets the client cannot
        // see. Each tick also re-authenticates subscribers, so expiry and
        // revoke take effect on open channels. Dead peers surface on the
        // next failed write and are pruned.
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = setInterval(() => {
          for (const sub of [...events]) {
            if (!subscriberAlive(sub)) {
              dropSubscribers((dead) => dead === sub)
              continue
            }
            try {
              sub.response.write(': ping\n\n')
            } catch {
              events.delete(sub)
            }
          }
        }, EVENT_HEARTBEAT_MS)
        heartbeat.unref?.()
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
      if (heartbeat) {
        clearInterval(heartbeat)
        heartbeat = null
      }
      for (const sub of events) {
        try {
          sub.response.end()
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
      for (const sub of [...events]) {
        try {
          sub.response.write(payload)
        } catch {
          events.delete(sub)
        }
      }
    },

    tlsStatus(): { secure: boolean; fingerprint: string | null; expiresAt: number | null } {
      return liveTlsStatus()
    },

    async dropSessions(): Promise<void> {
      sessions.clear()
      dropSubscribers((sub) => sub.auth.kind === 'session')
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
          dropSubscribers((sub) => sub.auth.kind === 'device' && sub.auth.token === token)
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
      dropSubscribers((sub) => sub.auth.kind === 'device')
      await persistDevices()
    }
  }
}
