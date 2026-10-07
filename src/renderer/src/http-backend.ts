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

/**
 * Phone boot entry: the QR code and copy-link carry the token in the fragment,
 * which browsers never send to the server, so it cannot leak into access logs.
 */
export function phoneEntryUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#t=${encodeURIComponent(token)}`
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

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}).`)
  }
  return (await response.json()) as T
}

/**
 * Backend implementation that talks to the LAN server over HTTP. Covers are
 * same-origin endpoint URLs (the served page is same-origin, so they satisfy
 * the content-security policy); the <audio> and <img> tags this enables
 * cannot send headers, which is why those endpoints also accept ?token=.
 *
 * Theme and EQ are per-device preferences kept in localStorage; everything
 * that touches the local filesystem, dialogs, or tagging rejects as
 * desktop-only. The phone UI never mounts those surfaces.
 */
export class HttpBackend implements Backend {
  readonly #baseUrl: string
  readonly #token: string
  readonly #storage: KeyValueStorage

  constructor(baseUrl: string, token: string, storage: KeyValueStorage) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#token = token
    this.#storage = storage
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /** Direct stream URL for the audio element, which cannot send headers. */
  streamUrl(path: string): string {
    return this.#url('/api/stream', { id: path })
  }

  #headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}` }
  }

  #url(path: string, params: Record<string, string> = {}): string {
    const query = new URLSearchParams({ ...params, token: this.#token }).toString()
    return `${this.#baseUrl}${path}?${query}`
  }

  async #get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return readJson<T>(await fetch(this.#url(path, params), { headers: this.#headers() }))
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
        url: this.#baseUrl
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

  async regenerateServerToken(): Promise<AppSettings> {
    throw unsupported('Server settings')
  }

  async getServerToken(): Promise<string | null> {
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
    // EventSource cannot send headers, so the token travels in the query —
    // the one place the server accepts it outside Authorization.
    const source = new EventSource(this.#url('/api/events'))
    source.onmessage = (event: MessageEvent) => {
      try {
        callback(toLibrarySummary(JSON.parse(event.data as string) as PublicLibrarySummary))
      } catch {
        // A malformed push must never take the subscription down.
      }
    }
    return () => source.close()
  }
}
