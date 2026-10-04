import { describe, expect, it } from 'vitest'
import type { Track } from '@shared/types'
import { cacheKey, LibraryCache, planReconcile } from '@main/library/cache'

function track(path: string, mtimeMs = 1000, sizeBytes = 500): Track {
  return {
    path,
    title: 'Untitled',
    artist: 'Artist',
    album: 'Album',
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: 180,
    mtimeMs,
    sizeBytes
  }
}

describe('cacheKey', () => {
  it('changes when any component changes', () => {
    const base = { path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, path: 'b.mp3' }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, mtimeMs: 9 }))
    expect(cacheKey(base)).not.toBe(cacheKey({ ...base, sizeBytes: 9 }))
  })

  it('is stable for identical input', () => {
    const parts = { path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }))
  })

  it('does not collide across joined fields', () => {
    expect(cacheKey({ path: 'a\u00001', mtimeMs: 1, sizeBytes: 2 })).not.toBe(
      cacheKey({ path: 'a', mtimeMs: 1, sizeBytes: 2 })
    )
  })
})

describe('planReconcile', () => {
  it('classifies unchanged, new and removed files', () => {
    const cache = new Map([[cacheKey({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }), track('a.mp3', 1, 2)]])
    const plan = planReconcile(cache, [
      { path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 },
      { path: 'b.mp3', mtimeMs: 1, sizeBytes: 2 }
    ])

    expect(plan.reusable.map((p) => p.path)).toEqual(['a.mp3'])
    expect(plan.needsParse.map((p) => p.path)).toEqual(['b.mp3'])
    expect(plan.staleKeys).toEqual([])
  })

  it('flags an edited file as needing a re-parse and retires the old key', () => {
    const cache = new Map([[cacheKey({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }), track('a.mp3', 1, 2)]])
    const plan = planReconcile(cache, [{ path: 'a.mp3', mtimeMs: 99, sizeBytes: 2 }])

    expect(plan.reusable).toEqual([])
    expect(plan.needsParse.map((p) => p.path)).toEqual(['a.mp3'])
    expect(plan.staleKeys).toHaveLength(1)
  })

  it('reports files that disappeared from disk', () => {
    const cache = new Map([
      [cacheKey({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }), track('a.mp3', 1, 2)],
      [cacheKey({ path: 'gone.mp3', mtimeMs: 1, sizeBytes: 2 }), track('gone.mp3', 1, 2)]
    ])
    const plan = planReconcile(cache, [{ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }])

    expect(plan.staleKeys).toHaveLength(1)
    expect(plan.staleKeys[0]).toContain('gone.mp3')
  })

  it('deduplicates repeated entries for the same file', () => {
    const parts = { path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }
    const plan = planReconcile(new Map(), [parts, parts, parts])
    expect(plan.needsParse).toHaveLength(1)
  })

  it('handles an empty disk against a full cache', () => {
    const cache = new Map([[cacheKey({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }), track('a.mp3', 1, 2)]])
    const plan = planReconcile(cache, [])
    expect(plan.reusable).toEqual([])
    expect(plan.needsParse).toEqual([])
    expect(plan.staleKeys).toHaveLength(1)
  })
})

describe('LibraryCache', () => {
  it('stores and retrieves by file identity', () => {
    const cache = new LibraryCache()
    cache.set(track('a.mp3', 1, 2))

    expect(cache.size).toBe(1)
    expect(cache.get({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 })?.path).toBe('a.mp3')
    expect(cache.get({ path: 'a.mp3', mtimeMs: 5, sizeBytes: 2 })).toBeUndefined()
  })

  it('answers membership without loading', () => {
    const cache = new LibraryCache()
    cache.set(track('a.mp3', 1, 2))
    expect(cache.has({ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 })).toBe(true)
    expect(cache.has({ path: 'b.mp3', mtimeMs: 1, sizeBytes: 2 })).toBe(false)
  })

  it('reuses cached entries on a second scan and drops removed ones', () => {
    const cache = new LibraryCache()
    cache.set(track('a.mp3', 1, 2))
    cache.set(track('b.mp3', 1, 2))

    const summary = cache.reconcile([
      { path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 },
      { path: 'c.mp3', mtimeMs: 1, sizeBytes: 2 }
    ])

    expect(summary).toEqual({ reused: 1, parsed: 1, removed: 1 })
    // c.mp3 was planned but not parsed yet, so only the reused entry remains.
    expect(cache.size).toBe(1)
    expect(cache.has({ path: 'b.mp3', mtimeMs: 1, sizeBytes: 2 })).toBe(false)
  })

  it('keeps parsed entries so a later scan can reuse them', () => {
    const cache = new LibraryCache()
    cache.reconcile([{ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }])
    cache.set(track('a.mp3', 1, 2))

    expect(cache.reconcile([{ path: 'a.mp3', mtimeMs: 1, sizeBytes: 2 }])).toEqual({
      reused: 1,
      parsed: 0,
      removed: 0
    })
  })

  it('exposes and clears everything', () => {
    const cache = new LibraryCache()
    cache.set(track('a.mp3'))
    expect(cache.values()).toHaveLength(1)
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
