import type {
  DiscogsArtOutcome,
  DiscogsReleaseOutcome,
  DiscogsSearchOutcome,
  LibrarySummary,
  PublicLibrarySummary,
  TagUpdateItem,
  TagUpdateOutcome
} from '@shared/ipc'
import type { AppSettings, ScanResult } from '@shared/types'
import { DEFAULT_SERVER_PORT, isThemeId } from '@shared/types'
import { normalizeEqSettings } from './audio/settings'
import type { Backend } from './backend'

const THEME_KEY = 'onda.phone.theme'
const EQ_KEY = 'onda.phone.eq'

function unsupported(feature: string): Error {
  return new Error(`${feature} is only available on the desktop app.`)
}

/** Wire shape → app model: roots stay empty, opaque ids ride the path slots. */
function toLibrarySummary(publique: PublicLibrarySummary): LibrarySummary {
  return {
    tree: publique.tree,
    tracks: publique.tracks,
    trackCount: publique.trackCount,
    roots: [],
    missingRoots: [],
    scanning: publique.scanning
  }
}

/** Minimal storage surface; `window.localStorage` satisfies it in browsers. Callers inject it so Node tests stay DOM-free. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const SERVER_CREDS_KEY = 'onda.phone.server'

export interface ServerCredentials {
  readonly baseUrl: string
  readonly token: string
}

/** Remembered phone connection; null when never connected or hand-edited badly. */
export function loadServerCredentials(storage: KeyValueStorage): ServerCredentials | null {
  let parsed: unknown
  try {
    const raw = storage.getItem(SERVER_CREDS_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record['baseUrl'] !== 'string' || typeof record['token'] !== 'string') return null
  if (record['baseUrl'] === '' || record['token'] === '') return null
  return { baseUrl: record['baseUrl'], token: record['token'] }
}

export function saveServerCredentials(storage: KeyValueStorage, creds: ServerCredentials): void {
  storage.setItem(SERVER_CREDS_KEY, JSON.stringify(creds))
}

/** Minimal removal surface; `window.localStorage` satisfies it in browsers. */
export interface RemovableStorage {
  removeItem(key: string): void
}

/** Forgets a pairing (logged-out or revoked phone); the boot screen returns. */
export function clearServerCredentials(storage: RemovableStorage): void {
  storage.removeItem(SERVER_CREDS_KEY)
}

/**
 * Phone boot entry: the QR code and copy-link carry the token in the fragment,
 * which browsers never send to the server, so it cannot leak into access logs.
 * The server's certificate fingerprint rides along the same way so the phone
 * can show it for trust-on-first-use comparison.
 */
export function phoneEntryUrl(baseUrl: string, token: string, fingerprint: string | null = null): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/#t=${encodeURIComponent(token)}`
  return fingerprint ? `${base}&fp=${encodeURIComponent(fingerprint)}` : base
}

/** Inverse of phoneEntryUrl for the boot screen; null when absent. */
export function tokenFromHash(hash: string): string | null {
  const match = /(?:^|&)t=([^&]*)/.exec(hash.startsWith('#') ? hash.slice(1) : hash)
  if (!match?.[1]) return null
  try {
    const token = decodeURIComponent(match[1])
    return token === '' ? null : token
  } catch {
    return null
  }
}

/**
 * Which network a server URL belongs to. Tailscale owns 100.64.0.0/10, so a
 * matching IPv4 host is the tailnet door (reachable from anywhere);
 * anything else is the home LAN (same Wi-Fi only).
 */
export type ServerUrlKind = 'tailscale' | 'lan'

export function describeServerUrl(url: string): ServerUrlKind {
  try {
    const octets = new URL(url).hostname.split('.').map(Number)
    if (
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ) {
      const [first, second] = [octets[0] ?? -1, octets[1] ?? -1]
      if (first === 100 && second >= 64 && second <= 127) return 'tailscale'
    }
  } catch {
    // Unparseable stays on the safe side: home LAN only.
  }
  return 'lan'
}

/**
 * Pairing entry: the QR code and copy-link carry a single-use pairing code in
 * the fragment (never the master token), which the phone trades for its own
 * device token. Same fragment discipline as phoneEntryUrl.
 */
export function phonePairUrl(baseUrl: string, code: string, fingerprint: string | null = null): string {
  const base = `${baseUrl.replace(/\/+$/, '')}/#pair=${encodeURIComponent(code)}`
  return fingerprint ? `${base}&fp=${encodeURIComponent(fingerprint)}` : base
}

/** Inverse of phonePairUrl for the boot screen; null when absent. */
export function pairFromHash(hash: string): string | null {
  const match = /(?:^|&)pair=([^&]*)/.exec(hash.startsWith('#') ? hash.slice(1) : hash)
  if (!match?.[1]) return null
  try {
    const code = decodeURIComponent(match[1])
    return code === '' ? null : code
  } catch {
    return null
  }
}

/**
 * Expected certificate fingerprint from a boot link (`#...&fp=...`); null
 * when the link predates fingerprints. The phone cannot read TLS details
 * itself, so this is shown for manual comparison before connecting.
 */
export function fingerprintFromHash(hash: string): string | null {
  const match = /(?:^|&)fp=([^&]*)/.exec(hash.startsWith('#') ? hash.slice(1) : hash)
  if (!match?.[1]) return null
  try {
    const fingerprint = decodeURIComponent(match[1])
    return fingerprint === '' ? null : fingerprint
  } catch {
    return null
  }
}

/**
 * Redeems a pairing code for this device's own token. Called before any
 * HttpBackend exists (the token is the credential it is built with), so it
 * is a module function taking an explicit base URL. Throws on expired,
 * consumed, or wrong codes — the message names the likely cause.
 */
export async function exchangePairingCode(baseUrl: string, code: string, name: string): Promise<string> {
  const trimmedName = name.trim()
  if (trimmedName === '') throw new Error('Name your device first.')
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), name: trimmedName })
  })
  if (response.status === 401) {
    throw new Error('That pairing code is expired or already used — generate a fresh one on the desktop.')
  }
  if (!response.ok) {
    throw new Error(`Pairing failed (${response.status}).`)
  }
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || body.token === '') {
    throw new Error('Pairing failed — the server answered without a token.')
  }
  return body.token
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}).`)
  }
  return (await response.json()) as T
}

/**
 * Thrown when the server rejects even a fresh login: the device itself is
 * gone (idle-revoked, or manually revoked on the desktop). Unlike a wrong
 * token or a dead server, the remedy is re-pairing — callers route back to
 * the boot screen instead of showing a retryable error.
 */
export class LoggedOutError extends Error {
  constructor() {
    super('This phone was logged out — pair it again from the desktop app.')
    this.name = 'LoggedOutError'
  }
}

/**
 * Backend implementation that talks to the LAN server over HTTP. Covers are
 * same-origin endpoint URLs (the served page is same-origin, so they satisfy
 * the content-security policy).
 *
 * Auth is cookie-first: the first API call trades the token (bearer header,
 * never the URL) for an HttpOnly login cookie via POST /api/session, and
 * from then on URLs carry no token at all — <audio>, <img>, and EventSource
 * send the cookie automatically on same-origin requests. URLs built before
 * the session exists keep ?token= as a graceful fallback; the server accepts
 * either credential.
 *
 * Theme and EQ are per-device preferences kept in localStorage; everything
 * that touches the local filesystem, dialogs, or tagging rejects as
 * desktop-only. The phone UI never mounts those surfaces.
 */
export class HttpBackend implements Backend {
  readonly #baseUrl: string
  readonly #token: string
  readonly #storage: KeyValueStorage
  #sessionReady = false
  #sessionFlight: Promise<void> | null = null

  constructor(baseUrl: string, token: string, storage: KeyValueStorage) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#token = token
    this.#storage = storage
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /**
   * Logs in and stores the session cookie. Concurrent callers share one
   * handshake; a failure clears the flight so the next call retries instead
   * of caching a dead login. Throws when the token is wrong or the server
   * is unreachable — callers fail loudly rather than silently falling back
   * to tokens in URLs.
   */
  async startSession(): Promise<void> {
    if (this.#sessionReady) return
    if (!this.#sessionFlight) {
      this.#sessionFlight = (async (): Promise<void> => {
        await readJson(
          await fetch(`${this.#baseUrl}/api/session`, {
            method: 'POST',
            headers: this.#headers()
          })
        )
        this.#sessionReady = true
      })()
      // Clearing the flight must never surface as its own rejection: awaiters
      // already observe the original promise, so both branches resolve here.
      void this.#sessionFlight.then(
        () => {
          this.#sessionFlight = null
        },
        () => {
          this.#sessionFlight = null
        }
      )
    }
    await this.#sessionFlight
  }

  /** Direct stream URL for the audio element, which cannot send headers. */
  streamUrl(path: string): string {
    return this.#url('/api/stream', { id: path })
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}` }
  }

  #url(path: string, params: Record<string, string> = {}): string {
    // Once logged in the cookie authenticates, so the token stays out of the
    // URL entirely (logs, history, referrers). Before that, ?token= keeps
    // media working — the server accepts either credential.
    const effective = this.#sessionReady ? { ...params } : { ...params, token: this.#token }
    const query = new URLSearchParams(effective).toString()
    return query === '' ? `${this.#baseUrl}${path}` : `${this.#baseUrl}${path}?${query}`
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    await this.startSession()
    const response = await fetch(this.#url(path, params), { headers: this.#headers() })
    if (response.status !== 401) return readJson<T>(response)
    // The cookie may have died server-side (expiry or revoke) while this
    // client still believed it was logged in: one silent re-login, then
    // replay the request. A 401 here proves the server is reachable, so a
    // failed re-handshake means the device itself is gone — logged out.
    this.#sessionReady = false
    try {
      await this.startSession()
    } catch {
      throw new LoggedOutError()
    }
    const retry = await fetch(this.#url(path, params), { headers: this.#headers() })
    if (retry.status === 401) throw new LoggedOutError()
    return readJson<T>(retry)
  }

  /**
   * Logs this phone out: the server revokes the calling credential (session
   * or device) and clears the cookie. Stored credentials are the caller's to
   * clear — this only ends the server side.
   */
  async logout(): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/api/logout`, {
      method: 'POST',
      headers: this.#headers()
    })
    if (!response.ok && response.status !== 401) {
      throw new Error(`Logout failed (${response.status}).`)
    }
    // A 401 here just means there was nothing left to kill.
  }

  async pickFolders(): Promise<string[]> {
    throw unsupported('Choosing folders')
  }

  async pickFiles(): Promise<string[]> {
    throw unsupported('Choosing files')
  }

  async getLibrary(): Promise<LibrarySummary> {
    return toLibrarySummary(await this.#get<PublicLibrarySummary>('/api/library'))
  }

  async scanLibrary(): Promise<ScanResult> {
    throw unsupported('Scanning')
  }

  async cancelScan(): Promise<void> {
    throw unsupported('Scanning')
  }

  async removeRoot(): Promise<LibrarySummary> {
    throw unsupported('Forgetting folders')
  }

  async getSettings(): Promise<AppSettings> {
    const storedTheme = this.#storage.getItem(THEME_KEY)
    const storedEq = this.#storage.getItem(EQ_KEY)
    let eq = null
    if (storedEq) {
      try {
        eq = { ...normalizeEqSettings(JSON.parse(storedEq)) }
      } catch {
        eq = null
      }
    }
    return {
      theme: isThemeId(storedTheme) ? storedTheme : 'spotlight',
      discogsTokenSet: false,
      eq,
      server: {
        enabled: true,
        port: DEFAULT_SERVER_PORT,
        tokenSet: true,
        allowInsecure: false,
        url: this.#baseUrl,
        urls: [this.#baseUrl],
        // The phone trusts at the platform level (system trust prompt on
        // first connect); there is no fingerprint of its own to show.
        secure: this.#baseUrl.startsWith('https:'),
        fingerprint: null,
        certExpiresAt: null,
        devices: []
      }
    }
  }

  async setTheme(theme: string): Promise<AppSettings> {
    if (isThemeId(theme)) this.#storage.setItem(THEME_KEY, theme)
    return this.getSettings()
  }

  async setDiscogsToken(): Promise<AppSettings> {
    throw unsupported('Discogs')
  }

  async setEqSettings(eq: unknown): Promise<AppSettings> {
    const normalized = normalizeEqSettings(eq as Parameters<typeof normalizeEqSettings>[0])
    this.#storage.setItem(
      EQ_KEY,
      JSON.stringify({
        bandGainsDb: normalized.bandGainsDb,
        preampDb: normalized.preampDb,
        autoPreamp: normalized.autoPreamp,
        bassDb: normalized.bassDb,
        trebleDb: normalized.trebleDb
      })
    )
    return this.getSettings()
  }

  async setServerEnabled(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async setServerPort(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async setServerInsecure(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async regenerateServerToken(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async regenerateServerCert(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async getServerToken(): Promise<string | null> {
    throw unsupported('Server settings')
  }

  async getPairingCode(): Promise<{ code: string; expiresAt: number } | null> {
    throw unsupported('Server settings')
  }

  async burnPairingCode(): Promise<void> {
    throw unsupported('Server settings')
  }

  async revokeServerDevice(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const response = await fetch(this.#url('/api/stream', { path }), { headers: this.#headers() })
    if (!response.ok) throw new Error(`Request failed (${response.status}).`)
    return response.arrayBuffer()
  }

  async readCover(path: string): Promise<string | null> {
    // Same-origin endpoint URL: the image tag streams it with ?id=, since
    // tags cannot send headers. Broken links surface through the <img> error
    // fallback rather than here.
    return this.#url('/api/cover', { id: path })
  }

  async revealInExplorer(): Promise<void> {
    throw unsupported('Revealing files')
  }

  async updateTags(_items: readonly TagUpdateItem[]): Promise<TagUpdateOutcome> {
    throw unsupported('Tag editing')
  }

  async searchDiscogs(): Promise<DiscogsSearchOutcome> {
    throw unsupported('Discogs')
  }

  async getDiscogsRelease(): Promise<DiscogsReleaseOutcome> {
    throw unsupported('Discogs')
  }

  async fetchDiscogsArt(): Promise<DiscogsArtOutcome> {
    throw unsupported('Discogs')
  }

  onScanProgress(): () => void {
    return () => {}
  }

  onLibraryChanged(callback: (summary: LibrarySummary) => void): () => void {
    // EventSource cannot send headers, but same-origin requests carry the
    // session cookie automatically — so the subscription waits for login and
    // the token stays out of the URL entirely. If login fails there is
    // nothing to subscribe to (callers load the library first and will have
    // already surfaced that failure).
    let source: EventSource | null = null
    let closed = false
    void this.startSession().then(
      () => {
        if (closed) return
        source = new EventSource(this.#url('/api/events'))
        source.onmessage = (event: MessageEvent) => {
          try {
            callback(toLibrarySummary(JSON.parse(event.data as string) as PublicLibrarySummary))
          } catch {
            // A malformed push must never take the subscription down.
          }
        }
      },
      () => undefined
    )
    return () => {
      closed = true
      source?.close()
    }
  }
}
