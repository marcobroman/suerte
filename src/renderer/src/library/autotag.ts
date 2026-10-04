import type { DiscogsRelease, TagEdits, Track } from '@shared/types'

export interface AutoTagFile {
  readonly path: string
  readonly title: string
  readonly artist: string
  readonly album: string
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  const file = slash === -1 ? normalized : normalized.slice(slash + 1)
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

/**
 * Prefills the Discogs search box from the files at hand: known artist/album
 * first, falling back to the first filename when tags are missing entirely.
 */
export function buildAutoTagQuery(files: readonly AutoTagFile[]): string {
  const artist = files.map((file) => file.artist.trim()).find((name) => name !== '')
  const album = files.map((file) => file.album.trim()).find((name) => name !== '')
  const parts = [artist, album].filter((part): part is string => part !== undefined && part !== '')
  if (parts.length > 0) return parts.join(' ')
  const first = files[0]
  return first ? basenameOf(first.path) : ''
}

export function autoTagFilesOf(tracks: readonly Track[]): AutoTagFile[] {
  return tracks.map((track) => ({
    path: track.path,
    title: track.title,
    artist: track.artist,
    album: track.album
  }))
}

export interface AutoTagPair {
  readonly file: AutoTagFile
  /** Zero-based position; the written track number is one more. */
  readonly index: number
  readonly discogsTitle: string
}

export interface AutoTagMapping {
  readonly pairs: readonly AutoTagPair[]
  /** Files past the end of the release tracklist; left untouched. */
  readonly unmappedFiles: readonly AutoTagFile[]
  /** Release tracks with no local file; ignored by the apply. */
  readonly unmappedTracks: number
}

/** Positional mapping: file i takes release track i. Surplus on either side is reported, never guessed. */
export function mapReleaseToFiles(
  files: readonly AutoTagFile[],
  release: DiscogsRelease
): AutoTagMapping {
  const count = Math.min(files.length, release.tracks.length)
  const pairs: AutoTagPair[] = []
  for (let index = 0; index < count; index++) {
    const file = files[index]
    const discogs = release.tracks[index]
    if (!file || !discogs) continue
    pairs.push({ file, index, discogsTitle: discogs.title })
  }
  return {
    pairs,
    unmappedFiles: files.slice(count),
    unmappedTracks: Math.max(0, release.tracks.length - files.length)
  }
}

export interface AutoTagArt {
  readonly mime: string
  readonly data: Uint8Array
}

/**
 * One file's edits from a mapped release track. Blank release fields are
 * omitted so they never wipe good local data.
 */
export function editsForReleaseTrack(
  release: DiscogsRelease,
  pair: AutoTagPair,
  art?: AutoTagArt
): TagEdits {
  const edits: {
    title?: string
    artist?: string
    album?: string
    trackNo?: number
    year?: number
    art?: AutoTagArt
  } = { title: pair.discogsTitle, trackNo: pair.index + 1 }
  if (release.artist.trim() !== '') edits.artist = release.artist
  if (release.title.trim() !== '') edits.album = release.title
  if (release.year !== null) edits.year = release.year
  if (art) edits.art = art
  return edits
}

/** Friendly one-liners for tag-write failures in the apply results. */
export function describeTagError(kind: string): string {
  switch (kind) {
    case 'unsupported-format':
      return 'Not an MP3 — left untouched.'
    case 'unsupported-field':
      return 'A field cannot be written to this file.'
    case 'not-found':
      return 'File is gone.'
    case 'unreadable':
      return 'Could not read this file.'
    case 'write-failed':
      return 'Write failed; original kept.'
    case 'verify-failed':
      return 'Did not verify; original restored.'
    default:
      return 'Failed.'
  }
}
