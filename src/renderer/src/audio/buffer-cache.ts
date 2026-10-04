/**
 * Insertion-ordered LRU. `Map` keeps insertion order, so promoting on read is a
 * delete followed by a re-insert, and the first key is always the coldest.
 */
export class LruCache<K, V> {
  readonly #entries = new Map<K, V>()
  readonly #limit: number

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`LruCache limit must be a positive integer, got ${limit}`)
    }
    this.#limit = limit
  }

  get limit(): number {
    return this.#limit
  }

  get size(): number {
    return this.#entries.size
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  /** Reads and promotes, so a hot key survives the next eviction. */
  get(key: K): V | undefined {
    if (!this.#entries.has(key)) return undefined
    const value = this.#entries.get(key) as V
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return value
  }

  /** Reads without promoting, for diagnostics and tests. */
  peek(key: K): V | undefined {
    return this.#entries.get(key)
  }

  set(key: K, value: V): V | undefined {
    const evicted = this.#entries.has(key) ? undefined : this.#evictIfFull()
    this.#entries.delete(key)
    this.#entries.set(key, value)
    return evicted
  }

  delete(key: K): boolean {
    return this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  keys(): K[] {
    return [...this.#entries.keys()]
  }

  #evictIfFull(): V | undefined {
    if (this.#entries.size < this.#limit) return undefined
    const coldest = this.#entries.keys().next()
    if (coldest.done === true) return undefined
    const value = this.#entries.get(coldest.value)
    this.#entries.delete(coldest.value)
    return value
  }
}
