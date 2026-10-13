import { X509Certificate } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { LibrarySummary, PublicLibrarySummary } from '@shared/ipc'
import type { DeviceInfo, DeviceRecord, ServerSession, Track } from '@shared/types'
import { SECOND_MS } from '@shared/types'
import { selectServerTransport } from './server/net'
import { trackId } from './server/paths'
import { authorized } from './server/auth'
import { CredentialsStore, type PairingCode } from './server/credentials'
import { EventHub } from './server/events'
import { serveClient } from './server/media'
import type { CoverImage } from './library/covers'
import { routeAuthed, routePublic, type RouterContext } from './server/routes'
import { json } from './server/respond'

// Helpers live in ./server/*.ts; re-exported here so existing importers
// (`@main/server` in tests, ipc, index) keep working.
export {
  bucketIp,
  lanBaseUrl,
  lanBaseUrls,
  selectServerTransport,
  type ServerTransport
} from './server/net'
export { clientPathIn, insideRoots, trackId } from './server/paths'

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
  readCover(path: string): Promise<CoverImage | null>
  getRoots(): readonly string[]
  /** Built renderer directory, or null when it was never built (dev mode). */
  getClientDir(): string | null
}

/** Short-lived single-use pairing code minted for the QR/link flow. */
export type { PairingCode } from './server/credentials'

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
   * Ends every subscription authed by the master secret. Token rotation
   * changes the secret that device/session drops do not cover, so rotation
   * calls this to leave no open channel behind.
   */
  dropMasterSubscribers(): void
  /**
   * Invalidates one outstanding pairing code (desktop hid its QR). Unknown
   * or already-consumed codes report false; both are safe no-ops.
   */
  burnPairingCode(code: string): boolean
  /** Forgets every device and pending code (token rotation); persisted too. */
  dropDevices(): Promise<void>
}

/** Slowloris guard: headers must arrive promptly; bodies stream without a cap (media). */
const HEADERS_TIMEOUT_MS = 10 * SECOND_MS
/** Upper bound on request headers; the API needs a handful. */
const MAX_HEADER_COUNT = 100

/**
 * HSTS pin lifetime. Same value as the login-cookie age by coincidence, not
 * by coupling — keep the names separate so a change to one never moves the other.
 */
const HSTS_MAX_AGE_SEC = 31_536_000

export function createLibraryServer(deps: LibraryServerDeps): LibraryServer {
  let server: Server | HttpsServer | null = null
  let listening = false
  let boundPort = 0
  // Opaque id ↔ real path, rebuilt only when the track list itself is replaced
  // (i.e. on rescan); lookups in between are map hits. Shared by id
  // resolution and the public summary so each track list hashes exactly once.
  let idCache: { tracks: readonly Track[]; byPath: Map<string, string>; byId: Map<string, string> } | null = null
  // Handshake attempts per IP for the token bucket above. Never persisted.
  const handshakeAttempts = new Map<string, { count: number; resetAt: number }>()

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

  /**
   * Every credential store in one place. Auth helpers receive the instance
   * itself as their CredentialStores; subscriber drops route back through
   * the event hub below. NB: the drop adapter closes over `hub` (declared
   * below) and runs only on later revoke/drop calls — keep this construction
   * order (credentials first: the hub needs the instance, not vice versa).
   */
  const credentials = new CredentialsStore({
    getSessions: () => deps.getSessions(),
    saveSessions: (sessions) => deps.saveSessions(sessions),
    getDevices: () => deps.getDevices(),
    saveDevices: (devices) => deps.saveDevices(devices),
    dropSubscribers: (predicate) => hub.dropSubscribers((sub) => predicate(sub.auth))
  })

  /**
   * Live event subscribers with the credential that opened them. Checked on
   * every heartbeat and dropped proactively on revoke, so an expired or
   * revoked phone stops receiving library pushes — revocation takes effect
   * on open channels, not just new requests.
   */
  const hub = new EventHub({
    getMasterToken: () => deps.getToken(),
    credentials,
    summarize: () => publicSummary()
  })

  function trackIds(tracks: readonly Track[]): { byPath: Map<string, string>; byId: Map<string, string> } {
    if (!idCache || idCache.tracks !== tracks) {
      const byPath = new Map<string, string>()
      const byId = new Map<string, string>()
      for (const track of tracks) {
        const id = trackId(track.path)
        byPath.set(track.path, id)
        byId.set(id, track.path)
      }
      idCache = { tracks, byPath, byId }
    }
    return idCache
  }

  function resolveTrackId(id: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null
    return trackIds(deps.getSummary().tracks).byId.get(id) ?? null
  }

  // Memoized public summary: the track list is replaced wholesale on rescan
  // and otherwise referentially stable, so rebuild only when the tracks (or
  // the scanning flag phones display) change. Phones poll /api/library and
  // every push re-summarizes — without this each call re-hashes N paths and
  // re-serializes megabytes on the single-threaded main process.
  let summaryCache: { tracks: readonly Track[]; scanning: boolean; summary: PublicLibrarySummary } | null = null

  function publicSummary(): PublicLibrarySummary {
    const summary = deps.getSummary()
    if (
      summaryCache &&
      summaryCache.tracks === summary.tracks &&
      summaryCache.scanning === summary.scanning
    ) {
      return summaryCache.summary
    }
    const byPath = trackIds(summary.tracks).byPath
    const idOf = (path: string): string => byPath.get(path) ?? trackId(path)
    const built: PublicLibrarySummary = {
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
    summaryCache = { tracks: summary.tracks, scanning: summary.scanning, summary: built }
    return built
  }

  /**
   * Everything endpoint handlers need, built once: live getters route back
   * through createLibraryServer so routes stay stateless.
   */
  const routerCtx: RouterContext = {
    credentials,
    hub,
    getMasterToken: () => deps.getToken(),
    getTls: () => deps.getTls(),
    getRoots: () => deps.getRoots(),
    readCover: (path) => deps.readCover(path),
    getClientDir: () => deps.getClientDir(),
    resolveTrackId: (id) => resolveTrackId(id),
    publicSummary: () => publicSummary(),
    tlsFingerprint: () => liveTlsStatus().fingerprint,
    handshakeAttempts
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    // Pinned before any routing: tampering with transport security must not
    // depend on which endpoint answers.
    if (deps.getTls()) {
      response.setHeader('strict-transport-security', `max-age=${HSTS_MAX_AGE_SEC}`)
    }
    response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('referrer-policy', 'no-referrer')
    response.setHeader('cross-origin-resource-policy', 'same-origin')
    // Credential-accepting and public-identity routes answer first; the
    // GET-only gate and the auth gate below order everything else.
    if (await routePublic(request, response, url, routerCtx)) return
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    // The UI shell is public: a phone must load the page to enter its token.
    // Everything under /api/* requires the token instead.
    if (!url.pathname.startsWith('/api/')) {
      try {
        await serveClient(url.pathname, request, response, deps.getClientDir())
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'request failed' })
        else response.end()
      }
      return
    }
    const auth = authorized(request, url, deps.getToken(), credentials)
    if (!auth) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    await credentials.noteActivity(auth)
    if (await routeAuthed(request, response, url, auth, routerCtx)) return
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
        // see. Owned by start()/stop() like the socket itself.
        hub.startHeartbeat()
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
      hub.closeAll()
      const closing = server
      server = null
      listening = false
      boundPort = 0
      if (!closing) return Promise.resolve()
      return new Promise((resolve) => closing.close(() => resolve()))
    },

    pushLibraryChanged(): void {
      hub.pushLibraryChanged()
    },

    tlsStatus(): { secure: boolean; fingerprint: string | null; expiresAt: number | null } {
      return liveTlsStatus()
    },

    async dropSessions(): Promise<void> {
      return credentials.dropSessions()
    },

    issuePairingCode(): PairingCode {
      return credentials.issuePairingCode()
    },

    getDevices(): DeviceInfo[] {
      return credentials.getDevices()
    },

    async revokeDevice(id: string): Promise<boolean> {
      return credentials.revokeDevice(id)
    },

    burnPairingCode(code: string): boolean {
      return credentials.burnPairingCode(code)
    },

    async dropDevices(): Promise<void> {
      return credentials.dropDevices()
    },

    dropMasterSubscribers(): void {
      hub.dropSubscribers((sub) => sub.auth.kind === 'master')
    }
  }
}
