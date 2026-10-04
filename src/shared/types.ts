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
}

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
