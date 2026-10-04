import { describe, expect, it, vi } from 'vitest'
import { CoverStore } from '@/library/covers'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('CoverStore', () => {
  it('starts empty and distinguishes unknown from absent', () => {
    const store = new CoverStore(async () => null)
    expect(store.peek('a.mp3')).toBeUndefined()
    expect(store.has('a.mp3')).toBe(false)
    expect(store.size).toBe(0)
  })

  it('loads and caches a cover', async () => {
    const read = vi.fn(async () => 'data:image/jpeg;base64,AAA')
    const store = new CoverStore(read)

    store.request('a.mp3')
    await flush()

    expect(read).toHaveBeenCalledWith('a.mp3')
    expect(store.peek('a.mp3')).toBe('data:image/jpeg;base64,AAA')
    expect(store.size).toBe(1)
  })

  it('does not request the same path twice', async () => {
    const read = vi.fn(async () => 'data:x')
    const store = new CoverStore(read)

    store.request('a.mp3')
    store.request('a.mp3')
    await flush()
    store.request('a.mp3')
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('caches a null result so misses are not retried', async () => {
    const read = vi.fn(async () => null)
    const store = new CoverStore(read)

    store.request('a.mp3')
    await flush()
    store.request('a.mp3')
    await flush()

    expect(read).toHaveBeenCalledTimes(1)
    expect(store.peek('a.mp3')).toBeNull()
    expect(store.has('a.mp3')).toBe(true)
  })

  it('treats a rejected read as no artwork', async () => {
    const store = new CoverStore(async () => {
      throw new Error('boom')
    })

    store.request('a.mp3')
    await flush()

    expect(store.peek('a.mp3')).toBeNull()
    expect(store.isPending('a.mp3')).toBe(false)
  })

  it('notifies subscribers when a cover arrives', async () => {
    const store = new CoverStore(async () => 'data:x')
    const seen: (string | null | undefined)[] = []
    store.subscribe('a.mp3', () => seen.push(store.peek('a.mp3')))

    store.request('a.mp3')
    await flush()

    expect(seen).toEqual(['data:x'])
  })

  it('stops notifying after unsubscribe', async () => {
    const store = new CoverStore(async () => 'data:x')
    const listener = vi.fn()
    const unsubscribe = store.subscribe('a.mp3', listener)
    unsubscribe()

    store.request('a.mp3')
    await flush()

    expect(listener).not.toHaveBeenCalled()
  })

  it('notifies every subscriber of the same path', async () => {
    const store = new CoverStore(async () => 'data:x')
    const first = vi.fn()
    const second = vi.fn()
    store.subscribe('a.mp3', first)
    store.subscribe('a.mp3', second)

    store.request('a.mp3')
    await flush()

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('notifies a late subscriber only on later changes', async () => {
    const store = new CoverStore(async () => 'data:x')
    store.request('a.mp3')
    await flush()

    const late = vi.fn()
    store.subscribe('a.mp3', late)
    expect(late).not.toHaveBeenCalled()

    store.put('a.mp3', 'data:y')
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('accepts a pre-seeded value', () => {
    const store = new CoverStore(async () => 'data:x')
    store.put('a.mp3', 'data:seed')

    expect(store.peek('a.mp3')).toBe('data:seed')
  })

  it('clears', async () => {
    const store = new CoverStore(async () => 'data:x')
    store.request('a.mp3')
    await flush()

    store.clear()

    expect(store.size).toBe(0)
    expect(store.peek('a.mp3')).toBeUndefined()
  })
})
