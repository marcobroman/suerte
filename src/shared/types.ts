export interface Track {
  readonly path: string
  readonly title: string
  readonly artist: string
  readonly album: string
  readonly trackNo: number | null
  readonly discNo: number | null
  readonly year: number | null
  readonly durationSec: number
  readonly mtimeMs: number
  readonly sizeBytes: number
}

export interface Album {
  readonly key: string
  readonly artist: string
  readonly title: string
  readonly year: number | null
  readonly trackPaths: readonly string[]
}

export interface Artist {
  readonly name: string
  readonly albumKeys: readonly string[]
}

export interface LibraryTree {
  readonly artists: readonly Artist[]
  readonly albums: readonly Album[]
}

export interface EqSettings {
  bandGainsDb: number[]
  preampDb: number
  autoPreamp: boolean
  bassDb: number
  trebleDb: number
  masterVolume: number
}

/** Ten ISO bands, matching the DSP chain; also the persisted shape minus volume. */
export const EQ_BAND_COUNT = 10

/** Equalizer curve as stored in the config. Master volume stays session-only. */
export interface PersistedEqSettings {
  readonly bandGainsDb: readonly number[]
  readonly preampDb: number
  readonly autoPreamp: boolean
  readonly bassDb: number
  readonly trebleDb: number
}

export interface Playlist {
  readonly name: string
  readonly paths: readonly string[]
}

/**
 * Sparse tag edits for audio files. Omitted fields are left untouched.
 * `discNo` is accepted for forward compatibility but the MP3 writer rejects it
 * (node-id3 has no TPOS support). `art` embeds a front-cover image.
 */
export interface TagEdits {
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly trackNo?: number
  readonly discNo?: number
  readonly year?: number
  readonly art?: {
    readonly mime: string
    readonly data: Uint8Array
  }
}

export type TagWriteError =
  | { readonly kind: 'unsupported-format' }
  | { readonly kind: 'unsupported-field'; readonly field: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unreadable'; readonly message: string }
  | { readonly kind: 'write-failed'; readonly message: string }
  | { readonly kind: 'verify-failed'; readonly message: string }

export interface TagWriteResult {
  readonly path: string
  readonly ok: boolean
  readonly error?: TagWriteError
}

/** One Discogs search hit. Search titles arrive as "Artist – Title", so `artist` is best-effort until the release is fetched. */
export interface DiscogsCandidate {
  readonly id: number
  readonly kind: 'master' | 'release'
  readonly title: string
  readonly artist: string
  readonly year: number | null
  readonly label: string
  readonly thumbUrl: string | null
}

export interface DiscogsTrack {
  /** Release position as printed ("A1", "3", …); mapping uses list order, not this. */
  readonly position: string
  readonly title: string
  readonly duration: string | null
}

export interface DiscogsRelease {
  readonly id: number
  readonly kind: 'master' | 'release'
  readonly artist: string
  readonly title: string
  readonly year: number | null
  readonly label: string
  readonly tracks: readonly DiscogsTrack[]
  readonly coverUrl: string | null
}

export const THEME_IDS = ['spotlight', 'midnight', 'daylight', 'ember', 'forest', 'violet', 'rose', 'sand'] as const

export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME: ThemeId = 'spotlight'

/** Guards values coming back from disk or the renderer, which are untrusted. */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/** Which palette is active. The actual colours live in the renderer stylesheet. */
export interface AppSettings {
  readonly theme: ThemeId
  /** The Discogs token itself never leaves the main process; this only says one is stored. */
  readonly discogsTokenSet: boolean
  /** Saved equalizer curve, without the (session-only) master volume. */
  readonly eq: PersistedEqSettings | null
  readonly server: ServerStatus
}

/** LAN server state for the renderer. The access token is exposed separately, on demand only. */
export interface ServerStatus {
  readonly enabled: boolean
  readonly port: number
  readonly tokenSet: boolean
  /** Reachable base URL while the server runs, else null. */
  readonly url: string | null

  /**
   * Explicit opt-in to serve plain HTTP when the certificate is missing or
   * broken. Off means fail closed: enabled but certless stays stopped.
   */
  readonly allowInsecure: boolean  /** Every reachable base URL (LAN plus tailnet when present), else []. */
  readonly urls: readonly string[]
  /** True while clients are served over TLS. */
  readonly secure: boolean
  /** SHA-256 cert fingerprint for trust-on-first-use, else null. */
  readonly fingerprint: string | null
  /** Cert expiry epoch ms, else null. */
  readonly certExpiresAt: number | null
  /** Paired phones/devices, for the desktop settings list. Always [] on phones. */
  readonly devices: readonly DeviceInfo[]
}

/** Persisted LAN server config. The token is generated on first enable. */
export interface ServerConfig {
  readonly enabled: boolean
  readonly port: number
  readonly token: string | undefined
  /** Serve plain HTTP when certless. Off (default) fails closed. */
  readonly allowInsecure: boolean
  /**
   * Issued login sessions (opaque ids, one per paired browser). Persisted so
   * phones stay logged in across restarts; wiped when the token rotates.
   */
  readonly sessions: readonly ServerSession[]
  /**
   * Paired devices (per-device tokens). The master token never leaves the
   * desktop: phones pair through single-use codes and get their own token,
   * revocable individually. Wiped when the token rotates.
   */
  readonly devices: readonly DeviceRecord[]
}

/** One issued phone/browser login session for the LAN server. */
export interface ServerSession {
  readonly id: string
  readonly createdAt: number
  /** Last request seen with this session; slides the idle expiry. */
  readonly lastSeen: number
}

/** One paired device: its own token plus a human name for the settings list. */
export interface DeviceRecord {
  readonly token: string
  readonly name: string
  readonly createdAt: number
  readonly lastSeen: number
}

/**
 * Device list entry for the desktop UI. The id is a one-way hash of the
 * device token — enough to revoke by, useless to log in with.
 */
export interface DeviceInfo {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly lastSeen: number
}

export const DEFAULT_SERVER_PORT = 4280

export interface ScanProgress {
  readonly scanned: number
  readonly total: number
  readonly currentPath: string
}

export interface ScanResult {
  readonly added: number
  readonly changed: number
  readonly removed: number
  readonly failed: number
  /** Files left unparsed because the scan was cancelled; not an error. */
  readonly cancelled: number
  readonly durationMs: number
}
