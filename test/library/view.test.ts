import { describe, expect, it } from 'vitest'
import { groupLibrary } from '@main/library/group'
import type { Track } from '@shared/types'
import {
  ALL_SELECTION,
  albumsForArtist,
  allAlbums,
  buildLibraryIndex,
  coverPathForAlbum,
  filterArtists,
  resolveView,
  selectionForAlbum,
  selectionForArtist,
  sortAlbums,
  tracksForAlbum
} from '@/library/view'
import { at } from '../helpers'

function track(path: string, overrides: Partial<Track> = {}): Track {
  return {
    path,
    title: path,
    artist: 'Artist',
    album: 'Album',
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: 100,
    mtimeMs: 0,
    sizeBytes: 0,
    ...overrides
  }
}

const library = [
  track('a/1.mp3', { title: 'One', artist: 'Aurora', album: 'Dawn', trackNo: 1, discNo: 1, year: 2001 }),
  track('a/2.mp3', { title: 'Two', artist: 'Aurora', album: 'Dawn', trackNo: 2, discNo: 1, year: 2001 }),
  track('a/3.mp3', { title: 'Three', artist: 'Aurora', album: 'Dusk', trackNo: 1, discNo: 1, year: 2005 }),
  track('b/1.mp3', { title: 'Beta', artist: 'Basalt', album: 'Dawn', trackNo: 1, discNo: 1 }),
  track('c/1.mp3', { title: 'Loose', artist: '', album: '', trackNo: null })
]

const index = buildLibraryIndex(groupLibrary(library), library)

describe('buildLibraryIndex', () => {
  it('indexes tracks by path', () => {
    expect(index.tracksByPath.size).toBe(5)
    expect(index.tracksByPath.get('a/1.mp3')?.title).toBe('One')
  })

  it('indexes albums by key', () => {
    expect(index.albumsByKey.size).toBe(4)
  })
})

describe('filterArtists', () => {
  it('returns every artist for an empty query', () => {
    expect(filterArtists(index, '')).toHaveLength(3)
    expect(filterArtists(index, '   ')).toHaveLength(3)
  })

  it('matches case-insensitively', () => {
    expect(filterArtists(index, 'aurora').map((a) => a.name)).toEqual(['Aurora'])
    expect(filterArtists(index, 'AURORA').map((a) => a.name)).toEqual(['Aurora'])
  })

  it('matches on a substring', () => {
    expect(filterArtists(index, 'as').map((a) => a.name)).toEqual(['Basalt'])
  })

  it('returns nothing when no artist matches', () => {
    expect(filterArtists(index, 'zzz')).toEqual([])
  })
})

describe('albumsForArtist', () => {
  it('returns that artist"s albums in tree order', () => {
    expect(albumsForArtist(index, 'Aurora').map((a) => a.title)).toEqual(['Dawn', 'Dusk'])
  })

  it('keeps same-titled albums from different artists apart', () => {
    expect(albumsForArtist(index, 'Basalt').map((a) => a.title)).toEqual(['Dawn'])
    expect(albumsForArtist(index, 'Aurora').map((a) => a.artist)).not.toContain('Basalt')
  })

  it('returns nothing for an unknown artist', () => {
    expect(albumsForArtist(index, 'Nobody')).toEqual([])
  })
})

describe('tracksForAlbum', () => {
  it('resolves paths to full track metadata', () => {
    const album = at(albumsForArtist(index, 'Aurora'), 0)
    expect(tracksForAlbum(index, album).map((t) => t.title)).toEqual(['One', 'Two'])
  })

  it('preserves the tree"s track order rather than sorting', () => {
    const album = at(albumsForArtist(index, 'Aurora'), 0)
    const scrambled = buildLibraryIndex(
      { artists: index.tree.artists, albums: [...index.tree.albums].reverse() },
      library
    )
    expect(tracksForAlbum(scrambled, album)).toHaveLength(2)
  })

  it('skips paths with no metadata', () => {
    const album = at(albumsForArtist(index, 'Aurora'), 0)
    const partial = buildLibraryIndex(index.tree, library.filter((t) => t.path !== 'a/2.mp3'))
    expect(tracksForAlbum(partial, album).map((t) => t.title)).toEqual(['One'])
  })
})

describe('allAlbums', () => {
  it('returns every album', () => {
    expect(allAlbums(index)).toHaveLength(4)
  })
})

describe('resolveView', () => {
  it('resolves all', () => {
    const view = resolveView(index, ALL_SELECTION)
    expect(view.selection.kind).toBe('all')
    expect(view.albums).toHaveLength(4)
    expect(view.tracks).toHaveLength(5)
  })

  it('resolves a single artist', () => {
    const view = resolveView(index, selectionForArtist(index.tree.artists[0]!))
    expect(view.selection.kind).toBe('artist')
    expect(view.albums.map((a) => a.title)).toEqual(['Dawn', 'Dusk'])
    expect(view.tracks.map((t) => t.title)).toEqual(['One', 'Two', 'Three'])
  })

  it('resolves a single album', () => {
    const album = albumsForArtist(index, 'Aurora')[1]!
    const view = resolveView(index, selectionForAlbum(album))
    expect(view.albums.map((a) => a.title)).toEqual(['Dusk'])
    expect(view.tracks.map((t) => t.title)).toEqual(['Three'])
  })

  it('applies the search to artists and albums without changing the selection', () => {
    const view = resolveView(index, ALL_SELECTION, 'aur')
    expect(view.artists.map((a) => a.name)).toEqual(['Aurora'])
    expect(view.albums.map((a) => a.title)).toEqual(['Dawn', 'Dusk'])
    expect(view.tracks.map((t) => t.title)).toEqual(['One', 'Two', 'Three'])
  })

  it('matches albums on title as well as artist', () => {
    const view = resolveView(index, ALL_SELECTION, 'dusk')
    expect(view.albums.map((a) => a.title)).toEqual(['Dusk'])
    expect(view.tracks.map((t) => t.title)).toEqual(['Three'])
  })

  it('filters an artist view down to matching albums', () => {
    const selection = selectionForArtist(index.tree.artists[0]!)
    const view = resolveView(index, selection, 'dusk')
    expect(view.selection.kind).toBe('artist')
    expect(view.albums.map((a) => a.title)).toEqual(['Dusk'])
    expect(view.tracks.map((t) => t.title)).toEqual(['Three'])
  })

  it('filters tracks inside an open album instead of navigating away', () => {
    const album = albumsForArtist(index, 'Aurora')[0]!
    const selection = selectionForAlbum(album)
    expect(resolveView(index, selection, 'two').tracks.map((t) => t.title)).toEqual(['Two'])
    const empty = resolveView(index, selection, 'zzz')
    expect(empty.albums.map((a) => a.title)).toEqual(['Dawn'])
    expect(empty.tracks).toEqual([])
  })

  it('matches tracks on title only, not artist', () => {
    const album = albumsForArtist(index, 'Aurora')[0]!
    const selection = selectionForAlbum(album)
    // Every track here is by Aurora, but none is titled that way.
    expect(resolveView(index, selection, 'aurora').tracks).toEqual([])
  })

  it('falls back to the whole library when the album is gone', () => {
    const view = resolveView(index, { kind: 'album', albumKey: 'nope' })
    expect(view.selection.kind).toBe('all')
    expect(view.tracks).toHaveLength(5)
  })

  it('falls back to the whole library when the artist is gone', () => {
    const view = resolveView(index, { kind: 'artist', artist: 'Ghost' })
    expect(view.selection.kind).toBe('all')
  })

  it('lists every track exactly once across albums', () => {
    const paths = resolveView(index, ALL_SELECTION).tracks.map((t) => t.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('keeps the queue scoped to the selection', () => {
    const album = at(albumsForArtist(index, 'Aurora'), 0)
    expect(resolveView(index, selectionForAlbum(album)).tracks).toHaveLength(2)
  })
})

describe('sortAlbums', () => {
  const label = (albums: readonly { artist: string; title: string }[]): string[] =>
    albums.map((a) => `${a.artist} – ${a.title}`)

  it('sorts by artist, then title', () => {
    expect(label(sortAlbums(index.tree.albums, 'artist', 'asc'))).toEqual([
      'Aurora – Dawn',
      'Aurora – Dusk',
      'Basalt – Dawn',
      'Unknown Artist – Unknown Album'
    ])
  })

  it('sorts by album title across artists', () => {
    expect(label(sortAlbums(index.tree.albums, 'title', 'asc'))).toEqual([
      'Aurora – Dawn',
      'Basalt – Dawn',
      'Aurora – Dusk',
      'Unknown Artist – Unknown Album'
    ])
  })

  it('sorts by year with unknown years last', () => {
    expect(label(sortAlbums(index.tree.albums, 'year', 'asc'))).toEqual([
      'Aurora – Dawn',
      'Aurora – Dusk',
      'Basalt – Dawn',
      'Unknown Artist – Unknown Album'
    ])
  })

  it('reverses with direction but keeps unknown years last', () => {
    expect(label(sortAlbums(index.tree.albums, 'year', 'desc'))).toEqual([
      'Aurora – Dusk',
      'Aurora – Dawn',
      'Unknown Artist – Unknown Album',
      'Basalt – Dawn'
    ])
    expect(label(sortAlbums(index.tree.albums, 'artist', 'desc'))[0]).toBe(
      'Unknown Artist – Unknown Album'
    )
  })

  it('does not mutate the input', () => {
    const before = index.tree.albums.map((a) => a.key)
    sortAlbums(index.tree.albums, 'year', 'desc')
    expect(index.tree.albums.map((a) => a.key)).toEqual(before)
  })
})

describe('coverPathForAlbum', () => {
  it('uses the first track as the cover source', () => {
    const album = at(albumsForArtist(index, 'Aurora'), 0)
    expect(coverPathForAlbum(album)).toBe('a/1.mp3')
  })

  it('returns null when there is no album', () => {
    expect(coverPathForAlbum(undefined)).toBeNull()
  })
})

