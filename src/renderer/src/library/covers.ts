import { useEffect, useState } from 'react'

export type CoverReader = (path: string) => Promise<string | null>

/**
 * Session cache for artwork. Each miss costs a full metadata parse in the main
 * process, so results are memoised here too, and a path is only ever requested
 * once even if several components ask for it at the same time.
 */
export class CoverStore {
  readonly #read: CoverReader
  readonly #entries = new Map<string, string | null>()
  readonly #pending = new Set<string>()
  readonly #listeners = new Map<string, Set<() => void>>()

  constructor(read: CoverReader) {
    this.#read = read
  }

  /** `undefined` when not looked up yet, `null` when known to have no artwork. */
  peek(path: string): string | null | undefined {
    return this.#entries.get(path)
  }

  has(path: string): boolean {
    return this.#entries.has(path)
  }

  get size(): number {
    return this.#entries.size
  }

  isPending(path: string): boolean {
    return this.#pending.has(path)
  }

  request(path: string): void {
    if (this.#entries.has(path) || this.#pending.has(path)) return
    this.#pending.add(path)
    void this.#read(path).then(
      (url) => this.#settle(path, url),
      () => this.#settle(path, null)
    )
  }

  /** Test and warm-up hook: seeds a known result without hitting the main process. */
  put(path: string, url: string | null): void {
    this.#settle(path, url)
  }

  clear(): void {
    this.#entries.clear()
    this.#listeners.clear()
  }

  subscribe(path: string, listener: () => void): () => void {
    let set = this.#listeners.get(path)
    if (!set) {
      set = new Set()
      this.#listeners.set(path, set)
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
      if (set && set.size === 0) this.#listeners.delete(path)
    }
  }

  #settle(path: string, url: string | null): void {
    this.#pending.delete(path)
    this.#entries.set(path, url)
    const set = this.#listeners.get(path)
    if (!set) return
    for (const listener of [...set]) listener()
  }
}

export function useCover(store: CoverStore, path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    path ? (store.peek(path) ?? null) : null
  )

  useEffect(() => {
    if (path === null) {
      setUrl(null)
      return
    }
    setUrl(store.peek(path) ?? null)
    store.request(path)
    return store.subscribe(path, () => setUrl(store.peek(path) ?? null))
  }, [store, path])

  return url
}
