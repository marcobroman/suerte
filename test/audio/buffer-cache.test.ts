import { describe, expect, it } from 'vitest'
import { LruCache } from '@/audio/buffer-cache'

describe('LruCache', () => {
  it('rejects a nonsensical limit', () => {
    expect(() => new LruCache<string, number>(0)).toThrow(RangeError)
    expect(() => new LruCache<string, number>(-1)).toThrow(RangeError)
    expect(() => new LruCache<string, number>(1.5)).toThrow(RangeError)
  })

  it('stores and retrieves', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    expect(cache.get('a')).toBe(1)
    expect(cache.size).toBe(1)
  })

  it('returns undefined for a missing key', () => {
    const cache = new LruCache<string, number>(3)
    expect(cache.get('nope')).toBeUndefined()
    expect(cache.has('nope')).toBe(false)
  })

  it('evicts the oldest entry when full', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })

  it('promotes on read so a hot key survives', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)

    cache.get('a')
    cache.set('c', 3)

    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })

  it('does not promote on peek', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)

    expect(cache.peek('a')).toBe(1)
    cache.set('c', 3)

    expect(cache.get('a')).toBeUndefined()
  })

  it('overwrites without growing or evicting', () => {
    const cache = new LruCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 9)

    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBe(9)
    expect(cache.get('b')).toBe(2)
  })

  it('reports the evicted value', () => {
    const cache = new LruCache<string, number>(1)
    expect(cache.set('a', 1)).toBeUndefined()
    expect(cache.set('b', 2)).toBe(1)
  })

  it('reports insertion order from coldest to hottest', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)

    expect(cache.keys()).toEqual(['b', 'a', 'c'])
  })

  it('deletes and clears', () => {
    const cache = new LruCache<string, number>(3)
    cache.set('a', 1)
    expect(cache.delete('a')).toBe(true)
    expect(cache.delete('a')).toBe(false)

    cache.set('b', 2)
    cache.clear()
    expect(cache.size).toBe(0)
  })

  it('exposes its limit', () => {
    expect(new LruCache<string, number>(7).limit).toBe(7)
  })

  it('keeps exactly the limit under churn', () => {
    const cache = new LruCache<string, number>(3)
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i)
    expect(cache.size).toBe(3)
    expect(cache.get('k49')).toBe(49)
    expect(cache.get('k0')).toBeUndefined()
  })
})
