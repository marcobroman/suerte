import { describe, expect, it } from 'vitest'
import { mapLimit } from '@main/util/map-limit'

describe('mapLimit', () => {
  it('returns an empty array for no items', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
  })

  it('preserves input order in the results', async () => {
    const result = await mapLimit([5, 1, 3], 2, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, (6 - n) / 2))
      return n * 10
    })
    expect(result).toEqual([50, 10, 30])
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let peak = 0
    await mapLimit(Array.from({ length: 40 }, (_, i) => i), 5, async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return null
    })
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
  })

  it('actually runs work in parallel', async () => {
    let started = 0
    await mapLimit([1, 2, 3, 4], 4, async () => {
      started += 1
      await new Promise((resolve) => setTimeout(resolve, 2))
      return null
    })
    expect(started).toBe(4)
  })

  it('passes the index to the worker', async () => {
    const seen: number[] = []
    await mapLimit(['a', 'b', 'c'], 1, async (_item, index) => {
      seen.push(index)
      return null
    })
    expect(seen).toEqual([0, 1, 2])
  })

  it('tolerates a nonsensical limit', async () => {
    expect(await mapLimit([1, 2], 0, async (n) => n)).toEqual([1, 2])
    expect(await mapLimit([1, 2], -5, async (n) => n)).toEqual([1, 2])
  })

  it('processes every item exactly once', async () => {
    const counts = new Map<number, number>()
    await mapLimit(Array.from({ length: 25 }, (_, i) => i), 4, async (item) => {
      counts.set(item, (counts.get(item) ?? 0) + 1)
      return null
    })
    expect(counts.size).toBe(25)
    for (const count of counts.values()) expect(count).toBe(1)
  })

  it('propagates a worker rejection', async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })
})
