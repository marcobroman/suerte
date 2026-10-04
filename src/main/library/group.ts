import type { Album, Artist, LibraryTree, Track } from '@shared/types'

export const UNKNOWN_ARTIST = 'Unknown Artist'
export const UNKNOWN_ALBUM = 'Unknown Album'

/** NUL cannot appear in a tag value, so it cannot collide across artist/album pairs. */
export const ALBUM_KEY_SEPARATOR = '\u0000'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareText(a: string, b: string): number {
  return collator.compare(a, b)
}

export function albumKey(artist: string, album: string): string {
  return `${artist}${ALBUM_KEY_SEPARATOR}${album}`
}

function compareTracks(a: Track, b: Track): number {
  const discA = a.discNo ?? Number.MAX_SAFE_INTEGER
  const discB = b.discNo ?? Number.MAX_SAFE_INTEGER
  if (discA !== discB) return discA - discB

  const trackA = a.trackNo ?? Number.MAX_SAFE_INTEGER
  const trackB = b.trackNo ?? Number.MAX_SAFE_INTEGER
  if (trackA !== trackB) return trackA - trackB

  return compareText(a.title, b.title)
}

function mostCommonYear(years: ReadonlyMap<number, number>): number | null {
  let best: number | null = null
  let bestCount = 0
  for (const [year, count] of years) {
    if (count > bestCount) {
      best = year
      bestCount = count
    }
  }
  return best
}

interface AlbumAccumulator {
  readonly key: string
  readonly artist: string
  readonly title: string
  readonly years: Map<number, number>
  readonly tracks: Track[]
}

/**
 * Folds a flat track list into the artist -> album -> track hierarchy the library
 * view renders. Albums are keyed by artist *and* title so two different artists
 * releasing a self-titled album stay separate.
 */
export function groupLibrary(tracks: readonly Track[]): LibraryTree {
  const accumulators = new Map<string, AlbumAccumulator>()

  for (const track of tracks) {
    const artist = track.artist.trim() || UNKNOWN_ARTIST
    const title = track.album.trim() || UNKNOWN_ALBUM
    const key = albumKey(artist, title)

    let accumulator = accumulators.get(key)
    if (accumulator === undefined) {
      accumulator = { key, artist, title, years: new Map(), tracks: [] }
      accumulators.set(key, accumulator)
    }
    accumulator.tracks.push(track)
    if (track.year !== null) {
      accumulator.years.set(track.year, (accumulator.years.get(track.year) ?? 0) + 1)
    }
  }

  // Emit in a fixed order so repeated scans of a reordered directory, or a
  // differently-ordered database read, produce an identical tree.
  const artistNames = [...new Set([...accumulators.values()].map((entry) => entry.artist))].sort(
    compareText
  )

  const albums: Album[] = []
  const artists: Artist[] = []

  for (const name of artistNames) {
    const owned = [...accumulators.values()].filter((entry) => entry.artist === name)
    owned.sort((a, b) => {
      const byTitle = compareText(a.title, b.title)
      if (byTitle !== 0) return byTitle
      return (mostCommonYear(a.years) ?? 0) - (mostCommonYear(b.years) ?? 0)
    })

    const albumKeys: string[] = []
    for (const entry of owned) {
      entry.tracks.sort(compareTracks)
      albums.push({
        key: entry.key,
        artist: entry.artist,
        title: entry.title,
        year: mostCommonYear(entry.years),
        trackPaths: entry.tracks.map((track) => track.path)
      })
      albumKeys.push(entry.key)
    }
    artists.push({ name, albumKeys })
  }

  return { artists, albums }
}
