import type { AppSettings, DiscogsRelease, DiscogsCandidate, LibraryTree, ScanProgress, ScanResult, TagEdits, TagWriteResult, Track } from './types'

export const IPC = {
  pickFolders: 'library:pick-folders',
  pickFiles: 'library:pick-files',
  getLibrary: 'library:get',
  scanLibrary: 'library:scan',
  cancelScan: 'library:cancel',
  removeRoot: 'library:remove-root',
  getSettings: 'settings:get',
  setTheme: 'settings:set-theme',
  setDiscogsToken: 'settings:set-discogs-token',
  setEqSettings: 'settings:set-eq',
  readFile: 'file:read',
  readCover: 'file:cover',
  revealInExplorer: 'file:reveal',
  updateTags: 'tags:update',
  searchDiscogs: 'discogs:search',
  getDiscogsRelease: 'discogs:release',
  fetchDiscogsArt: 'discogs:art',
  setServerEnabled: 'server:set-enabled',
  setServerPort: 'server:set-port',
  regenerateServerToken: 'server:regenerate-token',
  regenerateServerCert: 'server:regenerate-cert',
  getServerToken: 'server:get-token',
  getPairingCode: 'server:pairing-code',
  burnPairingCode: 'server:burn-code',
  revokeServerDevice: 'server:revoke-device'
} as const

export const SCAN_PROGRESS_CHANNEL = 'scan:progress'

/** Pushed after any scan finishes, including ones main starts on its own. */
export const LIBRARY_CHANGED_CHANNEL = 'library:changed'

export interface LibrarySummary {
  readonly tree: LibraryTree
  /** Flat track metadata, since the tree references tracks by path only. */
  readonly tracks: readonly Track[]
  readonly trackCount: number
  readonly roots: readonly string[]
  /** Roots that could not be reached; kept in the config so media can reappear. */
  readonly missingRoots: readonly string[]
  readonly scanning: boolean
}

/**
 * Library payload safe for the network: every absolute path is replaced by its
 * opaque track id (Album.trackPaths and Track.path carry ids, nothing else
 * changes shape), and roots are dropped entirely — the remote client never
 * needs local filesystem locations.
 */
export interface PublicLibrarySummary {
  readonly tree: LibraryTree
  readonly tracks: readonly Track[]
  readonly trackCount: number
  readonly scanning: boolean
}

/**
 * The entire privileged surface available to the renderer. The renderer runs
 * sandboxed with context isolation, so this contract plus the preload bridge is
 * the only way to touch the filesystem.
 */
export interface IpcApi {
  pickFolders(): Promise<string[]>
  pickFiles(): Promise<string[]>
  getLibrary(): Promise<LibrarySummary>
  scanLibrary(): Promise<ScanResult>
  cancelScan(): Promise<void>
  /** Forgets a folder, which is how an unplugged drive is finally dropped. */
  removeRoot(path: string): Promise<LibrarySummary>
  getSettings(): Promise<AppSettings>
  /** Ignores an unknown theme id and keeps the current one. */
  setTheme(theme: string): Promise<AppSettings>
  readFile(path: string): Promise<ArrayBuffer>
  readCover(path: string): Promise<string | null>
  revealInExplorer(path: string): Promise<void>
  /**
   * Rewrites tags file by file, then rescans so the library (and every
   * subscriber) picks the changes up. Per-file results: bulk edits never
   * fail atomically.
   */
  updateTags(items: readonly TagUpdateItem[]): Promise<TagUpdateOutcome>
  /**
   * Stores the Discogs personal token main-side (it is never exposed back).
   * An empty value clears the stored token.
   */
  setDiscogsToken(token: unknown): Promise<AppSettings>
  setEqSettings(eq: unknown): Promise<AppSettings>
  searchDiscogs(query: unknown): Promise<DiscogsSearchOutcome>
  getDiscogsRelease(id: unknown, kind: unknown): Promise<DiscogsReleaseOutcome>
  fetchDiscogsArt(url: unknown): Promise<DiscogsArtOutcome>
  setServerEnabled(on: unknown): Promise<AppSettings>
  setServerPort(port: unknown): Promise<AppSettings>
  regenerateServerToken(): Promise<AppSettings>
  /**
   * Rotates the TLS certificate (new fingerprint — phones re-trust once).
   * Sessions and devices survive: the identity changed, the logins did not.
   */
  regenerateServerCert(): Promise<AppSettings>
  getServerToken(): Promise<string | null>
  /**
   * Mints a single-use pairing code for the QR/link flow, or null when the
   * server is not listening (a code would be unusable). The master token
   * itself never travels to the phone.
   */
  getPairingCode(): Promise<{ code: string; expiresAt: number } | null>
  /**
   * Invalidates a previously displayed pairing code (its QR was hidden).
   * Unknown codes are a silent no-op; nothing observable changes.
   */
  burnPairingCode(code: unknown): Promise<void>
  /** Revokes one paired device by its id; unknown ids are a no-op success. */
  revokeServerDevice(id: unknown): Promise<AppSettings>
  onScanProgress(callback: (progress: ScanProgress) => void): () => void
  onLibraryChanged(callback: (summary: LibrarySummary) => void): () => void
}

export interface TagUpdateItem {
  readonly path: string
  readonly edits: TagEdits
}

export interface TagUpdateOutcome {
  readonly results: readonly TagWriteResult[]
  readonly scan: ScanResult
}

export type DiscogsErrorKind =
  | 'missing-token'
  | 'unauthorized'
  | 'rate-limited'
  | 'not-found'
  | 'network'

export interface DiscogsFailure {
  readonly kind: DiscogsErrorKind
  readonly message: string
}

export type DiscogsSearchOutcome =
  | { readonly ok: true; readonly candidates: readonly DiscogsCandidate[] }
  | { readonly ok: false; readonly error: DiscogsFailure }

export type DiscogsReleaseOutcome =
  | { readonly ok: true; readonly release: DiscogsRelease }
  | { readonly ok: false; readonly error: DiscogsFailure }

export interface DiscogsArtPayload {
  readonly mime: string
  readonly data: Uint8Array
}

export type DiscogsArtOutcome =
  | { readonly ok: true; readonly art: DiscogsArtPayload }
  | { readonly ok: false; readonly error: DiscogsFailure }

export interface AppInfo {
  readonly electron: string
  readonly chrome: string
  readonly node: string
}

export interface PreloadApi extends IpcApi {
  readonly appInfo: AppInfo
}
