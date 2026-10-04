import type { Album, Artist, LibraryTree, Track } from '@shared/types'

export type Selection =
  | { readonly kind: 'all' }
  | { readonly kind: 'artist'; readonly artist: string }
  | { readonly kind: 'album'; readonly albumKey: string }

export interface LibraryIndex {
  readonly tree: LibraryTree
  readonly tracksByPath: ReadonlyMap<string, Track>
  readonly albumsByKey: ReadonlyMap<string, Album>
}

/**
 * `groupLibrary` already emits artists, albums and tracks in display order, so the
 * index only resolves identities. Nothing here re-sorts: order comes from the tree.
 */
export function buildLibraryIndex(
  tree: LibraryTree,
  tracks: readonly Track[]
): LibraryIndex {
  const tracksByPath = new Map<string, Track>()
  for (const track of tracks) tracksByPath.set(track.path, track)

  const albumsByKey = new Map<string, Album>()
  for (const album of tree.albums) albumsByKey.set(album.key, album)

  return { tree, tracksByPath, albumsByKey }
}

export function albumsForArtist(index: LibraryIndex, artistName: string): Album[] {
  const artist = index.tree.artists.find((entry) => entry.name === artistName)
  if (!artist) return []
  const albums: Album[] = []
  for (const key of artist.albumKeys) {
    const album = index.albumsByKey.get(key)
    if (album) albums.push(album)
  }
  return albums
}

export function tracksForAlbum(index: LibraryIndex, album: Album): Track[] {
  const tracks: Track[] = []
  for (const path of album.trackPaths) {
    const track = index.tracksByPath.get(path)
    if (track) tracks.push(track)
  }
  return tracks
}

export function allAlbums(index: LibraryIndex): Album[] {
  return [...index.tree.albums]
}

export function filterArtists(index: LibraryIndex, query: string): Artist[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...index.tree.artists]
  return index.tree.artists.filter((artist) => artist.name.toLowerCase().includes(needle))
}

export interface ResolvedView {
  readonly selection: Selection
  readonly artists: readonly Artist[]
  readonly albums: readonly Album[]
  readonly tracks: readonly Track[]
}

/**
 * Resolves a selection into the three panes. The query is a global library
 * search: it narrows the artist list, the album list (by album title or album
 * artist), and — inside an album — the track list. An open album is never
 * yanked away by typing; its tracks just filter down. A selection that no
 * longer resolves, which happens when a rescan drops the artist or album,
 * falls back to the whole library rather than rendering an empty browser.
 */
export function resolveView(
  index: LibraryIndex,
  selection: Selection,
  query = ''
): ResolvedView {
  const needle = query.trim().toLowerCase()
  const artists = filterArtists(index, query)

  if (selection.kind === 'album') {
    const album = index.albumsByKey.get(selection.albumKey)
    if (album) {
      return {
        selection,
        artists,
        albums: [album],
        tracks: tracksForAlbum(index, album).filter((track) => matchTrack(track, needle))
      }
    }
  }

  if (selection.kind === 'artist') {
    const mine = albumsForArtist(index, selection.artist)
    if (mine.length > 0) {
      const albums = mine.filter((album) => matchAlbum(album, needle))
      return {
        selection,
        artists,
        albums,
        tracks: albums.flatMap((album) => tracksForAlbum(index, album))
      }
    }
  }

  const albums = allAlbums(index).filter((album) => matchAlbum(album, needle))
  return {
    selection: { kind: 'all' },
    artists,
    albums,
    tracks: albums.flatMap((album) => tracksForAlbum(index, album))
  }
}

/** Path whose cover art represents an album; albums share artwork by convention. */
export function coverPathForAlbum(album: Album | undefined): string | null {
  return album?.trackPaths[0] ?? null
}

const sortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareAlbumText(a: string, b: string): number {
  return sortCollator.compare(a, b)
}

export type AlbumSortKey = 'artist' | 'title' | 'year'
export type AlbumSortDir = 'asc' | 'desc'

export const ALBUM_SORT_OPTIONS: readonly { readonly id: AlbumSortKey; readonly label: string }[] = [
  { id: 'artist', label: 'Artist' },
  { id: 'title', label: 'Album title' },
  { id: 'year', label: 'Year' }
]

/**
 * Orders album tiles for display. Unknown years always sort last, in either
 * direction; everything else reverses with the direction. Tiebreaks keep the
 * order deterministic.
 */
export function sortAlbums(
  albums: readonly Album[],
  key: AlbumSortKey,
  dir: AlbumSortDir = 'asc'
): Album[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...albums].sort((a, b) => {
    if (key === 'title') {
      return sign * (compareAlbumText(a.title, b.title) || compareAlbumText(a.artist, b.artist))
    }
    if (key === 'year') {
      if (a.year === null && b.year === null) {
        // Fall through to the shared tiebreak below.
      } else if (a.year === null) {
        return 1
      } else if (b.year === null) {
        return -1
      } else if (a.year !== b.year) {
        return sign * (a.year - b.year)
      }
      return sign * (compareAlbumText(a.artist, b.artist) || compareAlbumText(a.title, b.title))
    }
    return (
      sign *
      (compareAlbumText(a.artist, b.artist) ||
        compareAlbumText(a.title, b.title) ||
        (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER))
    )
  })
}

/** Global-search match on album title or album artist; empty query matches all. */
export function matchAlbum(album: Album, needle: string): boolean {
  if (needle === '') return true
  return (
    album.title.toLowerCase().includes(needle) || album.artist.toLowerCase().includes(needle)
  )
}

/** Global-search match on track title only; empty query matches all. Artist hits
 * already surface through the album results and the sidebar, so matching them
 * here would only duplicate the track list. */
export function matchTrack(track: Track, needle: string): boolean {
  if (needle === '') return true
  return track.title.toLowerCase().includes(needle)
}

export function selectionForAlbum(album: Album): Selection {
  return { kind: 'album', albumKey: album.key }
}

export function selectionForArtist(artist: Artist): Selection {
  return { kind: 'artist', artist: artist.name }
}

export const ALL_SELECTION: Selection = { kind: 'all' }
