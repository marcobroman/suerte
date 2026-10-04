import type { Track } from '@shared/types'

export interface CacheKeyParts {
  readonly path: string
  readonly mtimeMs: number
  readonly sizeBytes: number
}

/**
 * Identity of a file's *contents as last parsed*. Keying on path alone would serve
 * stale tags after an external edit; adding mtime and size catches that in a stat.
 */
export function cacheKey(parts: CacheKeyParts): string {
  return `${parts.path}\u0000${parts.mtimeMs}\u0000${parts.sizeBytes}`
}

export interface ReconcilePlan {
  readonly reusable: readonly CacheKeyParts[]
  readonly needsParse: readonly CacheKeyParts[]
  readonly staleKeys: readonly string[]
}

/** Decides which files can skip parsing and which cache entries are now dead. */
export function planReconcile(
  cache: ReadonlyMap<string, Track>,
  current: readonly CacheKeyParts[]
): ReconcilePlan {
  const reusable: CacheKeyParts[] = []
  const needsParse: CacheKeyParts[] = []
  const live = new Set<string>()

  for (const parts of current) {
    const key = cacheKey(parts)
    if (live.has(key)) continue
    live.add(key)
    if (cache.has(key)) reusable.push(parts)
    else needsParse.push(parts)
  }

  const staleKeys: string[] = []
  for (const key of cache.keys()) {
    if (!live.has(key)) staleKeys.push(key)
  }

  return { reusable, needsParse, staleKeys }
}

export interface ReconcileSummary {
  readonly reused: number
  readonly parsed: number
  readonly removed: number
}

/**
 * Session-scoped parse cache standing in for a database. Holds metadata for every
 * file on disk so a rescan only has to stat and re-parse what actually changed.
 */
export class LibraryCache {
  readonly #entries = new Map<string, Track>()

  get size(): number {
    return this.#entries.size
  }

  has(parts: CacheKeyParts): boolean {
    return this.#entries.has(cacheKey(parts))
  }

  get(parts: CacheKeyParts): Track | undefined {
    return this.#entries.get(cacheKey(parts))
  }

  set(track: Track): void {
    this.#entries.set(
      cacheKey({ path: track.path, mtimeMs: track.mtimeMs, sizeBytes: track.sizeBytes }),
      track
    )
  }

  values(): Track[] {
    return [...this.#entries.values()]
  }

  apply(plan: ReconcilePlan): void {
    for (const key of plan.staleKeys) this.#entries.delete(key)
  }

  /** Plans against the current disk state and drops dead entries in one step. */
  planAndApply(current: readonly CacheKeyParts[]): ReconcilePlan {
    const plan = planReconcile(this.#entries, current)
    this.apply(plan)
    return plan
  }

  reconcile(current: readonly CacheKeyParts[]): ReconcileSummary {
    const plan = this.planAndApply(current)
    return {
      reused: plan.reusable.length,
      parsed: plan.needsParse.length,
      removed: plan.staleKeys.length
    }
  }

  clear(): void {
    this.#entries.clear()
  }
}
