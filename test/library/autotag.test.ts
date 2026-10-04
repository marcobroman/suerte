import { describe, expect, it } from 'vitest'
import type { DiscogsRelease } from '@shared/types'
import {
  autoTagFilesOf,
  buildAutoTagQuery,
  describeTagError,
  editsForReleaseTrack,
  mapReleaseToFiles,
  type AutoTagFile
} from '@/library/autotag'

function file(path: string, overrides: Partial<AutoTagFile> = {}): AutoTagFile {
  return { path, title: 'T', artist: 'A', album: 'B', ...overrides }
}

function release(titles: readonly string[], overrides: Partial<DiscogsRelease> = {}): DiscogsRelease {
  return {
    id: 1,
    kind: 'master',
    artist: 'Aurora',
    title: 'Dawn',
    year: 2001,
    label: 'Northern',
    tracks: titles.map((title, index) => ({ position: `A${index + 1}`, title, duration: null })),
    coverUrl: null,
    ...overrides
  }
}

describe('buildAutoTagQuery', () => {
  it('joins known artist and album', () => {
    expect(buildAutoTagQuery([file('a.mp3')])).toBe('A B')
  })

  it('falls back to the filename when tags are blank', () => {
    expect(
      buildAutoTagQuery([file('C:\\music\\mystery_song.mp3', { artist: '', album: '' })])
    ).toBe('mystery_song')
  })

  it('is empty with no files', () => {
    expect(buildAutoTagQuery([])).toBe('')
  })
})

describe('autoTagFilesOf', () => {
  it('keeps the fields mapping needs', () => {
    const base = {
      trackNo: null,
      discNo: null,
      year: null,
      durationSec: 0,
      mtimeMs: 0,
      sizeBytes: 0
    }
    const tracks = [
      { ...base, path: 'a.mp3', title: 'One', artist: 'A', album: 'B' },
      { ...base, path: 'b.mp3', title: 'Two', artist: '', album: '' }
    ]
    expect(autoTagFilesOf(tracks)).toEqual([
      { path: 'a.mp3', title: 'One', artist: 'A', album: 'B' },
      { path: 'b.mp3', title: 'Two', artist: '', album: '' }
    ])
  })
})

describe('mapReleaseToFiles', () => {
  it('maps by position up to the shorter side', () => {
    const mapping = mapReleaseToFiles(
      [file('a.mp3'), file('b.mp3'), file('c.mp3')],
      release(['One', 'Two'])
    )

    expect(mapping.pairs.map((pair) => [pair.file.path, pair.discogsTitle, pair.index])).toEqual([
      ['a.mp3', 'One', 0],
      ['b.mp3', 'Two', 1]
    ])
    expect(mapping.unmappedFiles.map((entry) => entry.path)).toEqual(['c.mp3'])
    expect(mapping.unmappedTracks).toBe(0)
  })

  it('reports surplus release tracks', () => {
    const mapping = mapReleaseToFiles([file('a.mp3')], release(['One', 'Two', 'Three']))

    expect(mapping.pairs).toHaveLength(1)
    expect(mapping.unmappedFiles).toEqual([])
    expect(mapping.unmappedTracks).toBe(2)
  })
})

describe('editsForReleaseTrack', () => {
  it('builds one-based track numbers with shared fields', () => {
    const mapping = mapReleaseToFiles([file('a.mp3'), file('b.mp3')], release(['One', 'Two']))
    const pair = mapping.pairs[1]
    if (!pair) throw new Error('expected a pair')

    expect(editsForReleaseTrack(release(['One', 'Two']), pair)).toEqual({
      title: 'Two',
      artist: 'Aurora',
      album: 'Dawn',
      trackNo: 2,
      year: 2001
    })
  })

  it('omits blank release fields instead of wiping local data', () => {
    const bare = release(['One'], { artist: '', title: '', year: null })
    const mapping = mapReleaseToFiles([file('a.mp3')], bare)
    const pair = mapping.pairs[0]
    if (!pair) throw new Error('expected a pair')

    expect(editsForReleaseTrack(bare, pair)).toEqual({ title: 'One', trackNo: 1 })
  })

  it('attaches art when provided', () => {
    const mapping = mapReleaseToFiles([file('a.mp3')], release(['One']))
    const pair = mapping.pairs[0]
    if (!pair) throw new Error('expected a pair')
    const art = { mime: 'image/jpeg', data: new Uint8Array([1, 2, 3]) }

    expect(editsForReleaseTrack(release(['One']), pair, art).art).toBe(art)
  })
})

describe('describeTagError', () => {
  it('covers every writer error kind', () => {
    for (const kind of [
      'unsupported-format',
      'unsupported-field',
      'not-found',
      'unreadable',
      'write-failed',
      'verify-failed',
      'whatever'
    ]) {
      expect(describeTagError(kind).length).toBeGreaterThan(0)
    }
  })
})
