import { describe, expect, it } from 'vitest'
import type { Track } from '@shared/types'
import {
  albumKey,
  compareText,
  groupLibrary,
  UNKNOWN_ALBUM,
  UNKNOWN_ARTIST
} from '@main/library/group'
import { at } from '../helpers'

let counter = 0

function track(overrides: Partial<Track> = {}): Track {
  counter += 1
  const name = overrides.path ?? `track-${counter}.mp3`
  return {
    path: name,
    title: 'Untitled',
    artist: 'Artist',
    album: 'Album',
    trackNo: 1,
    discNo: 1,
    year: 2000,
    durationSec: 180,
    mtimeMs: 1000,
    sizeBytes: 1000,
    ...overrides
  }
}

describe('albumKey', () => {
  it('separates artist from album unambiguously', () => {
    // Without a separator these two would collide.
    expect(albumKey('AB', 'C')).not.toBe(albumKey('A', 'BC'))
  })
})

describe('compareText', () => {
  it('sorts numbers inside strings naturally', () => {
    const input = ['Track 10', 'Track 2', 'Track 1']
    expect([...input].sort(compareText)).toEqual(['Track 1', 'Track 2', 'Track 10'])
  })

  it('ignores case', () => {
    expect(compareText('alpha', 'ALPHA')).toBe(0)
  })
})

describe('groupLibrary', () => {
  it('returns empty trees for no tracks', () => {
    expect(groupLibrary([])).toEqual({ artists: [], albums: [] })
  })

  it('folds tracks into artist and album levels', () => {
    const tree = groupLibrary([
      track({ path: 'a.mp3', artist: 'Portishead', album: 'Dummy', title: 'Roads' }),
      track({ path: 'b.mp3', artist: 'Portishead', album: 'Dummy', title: 'Sour Times' })
    ])

    expect(tree.artists).toHaveLength(1)
    expect(at(tree.artists, 0).name).toBe('Portishead')

    const album = at(tree.albums, 0)
    expect(album.title).toBe('Dummy')
    expect(album.artist).toBe('Portishead')
    expect(album.trackPaths).toEqual(['a.mp3', 'b.mp3'])
  })

  it('keeps same-titled albums from different artists apart', () => {
    const tree = groupLibrary([
      track({ path: 'x.mp3', artist: 'Metallica', album: 'Self-titled' }),
      track({ path: 'y.mp3', artist: 'Beck', album: 'Self-titled' })
    ])

    expect(tree.artists).toHaveLength(2)
    expect(tree.albums).toHaveLength(2)
  })

  it('sorts artists alphabetically', () => {
    const tree = groupLibrary([
      track({ artist: 'Portishead' }),
      track({ artist: 'Beck' }),
      track({ artist: 'Aphex Twin' })
    ])
    expect(tree.artists.map((a) => a.name)).toEqual(['Aphex Twin', 'Beck', 'Portishead'])
  })

  it('sorts albums alphabetically within an artist', () => {
    const tree = groupLibrary([
      track({ artist: 'Beck', album: 'Odelay' }),
      track({ artist: 'Beck', album: 'Mutations' }),
      track({ artist: 'Beck', album: 'Colors' })
    ])
    const keys = at(tree.artists, 0).albumKeys
    expect(keys.map((key) => at(tree.albums, tree.albums.findIndex((a) => a.key === key)).title)).toEqual([
      'Colors',
      'Mutations',
      'Odelay'
    ])
  })

  it('orders tracks by disc then track number', () => {
    const tree = groupLibrary([
      track({ path: 'd2t1.mp3', discNo: 2, trackNo: 1 }),
      track({ path: 'd1t2.mp3', discNo: 1, trackNo: 2 }),
      track({ path: 'd1t1.mp3', discNo: 1, trackNo: 1 })
    ])
    expect(at(tree.albums, 0).trackPaths).toEqual(['d1t1.mp3', 'd1t2.mp3', 'd2t1.mp3'])
  })

  it('sorts unnumbered tracks after numbered ones, by title', () => {
    const tree = groupLibrary([
      track({ path: 'none-b.mp3', trackNo: null, title: 'Bravo' }),
      track({ path: 'two.mp3', trackNo: 2, title: 'Zulu' }),
      track({ path: 'none-a.mp3', trackNo: null, title: 'Alpha' })
    ])
    expect(at(tree.albums, 0).trackPaths).toEqual(['two.mp3', 'none-a.mp3', 'none-b.mp3'])
  })

  it('buckets missing artists and albums', () => {
    const tree = groupLibrary([track({ artist: '   ', album: '' })])
    const album = at(tree.albums, 0)
    expect(album.artist).toBe(UNKNOWN_ARTIST)
    expect(album.title).toBe(UNKNOWN_ALBUM)
  })

  it('takes the most common year on an album', () => {
    const tree = groupLibrary([
      track({ year: 1994 }),
      track({ year: 1994 }),
      track({ year: 2011 })
    ])
    expect(at(tree.albums, 0).year).toBe(1994)
  })

  it('reports a null year when nothing is tagged', () => {
    const tree = groupLibrary([track({ year: null })])
    expect(at(tree.albums, 0).year).toBeNull()
  })

  it('is stable regardless of input order', () => {
    const tracks = [
      track({ path: 'p.mp3', artist: 'B', album: 'Two', trackNo: 2 }),
      track({ path: 'q.mp3', artist: 'B', album: 'One', trackNo: 1 }),
      track({ path: 'r.mp3', artist: 'A', album: 'Only', trackNo: 1 })
    ]
    expect(JSON.stringify(groupLibrary(tracks))).toBe(
      JSON.stringify(groupLibrary([...tracks].reverse()))
    )
  })
})
