import { parseFile, selectCover } from 'music-metadata'

const MAX_CACHED_COVERS = 64

/**
 * Cover art is keyed by track path and pulled on demand rather than during the scan,
 * where decoding images would dominate parse time. Albums share artwork, so this
 * fills slowly in practice; the cap keeps a large library from pinning megabytes.
 */
export class CoverCache {
  readonly #entries = new Map<string, string | null>()

  /** `undefined` means never looked up, `null` means known to have no artwork. */
  get(path: string): string | null | undefined {
    return this.#entries.get(path)
  }

  set(path: string, dataUrl: string | null): void {
    if (this.#entries.size >= MAX_CACHED_COVERS && !this.#entries.has(path)) {
      const oldest = this.#entries.keys().next()
      if (oldest.done !== true) this.#entries.delete(oldest.value)
    }
    this.#entries.set(path, dataUrl)
  }

  get size(): number {
    return this.#entries.size
  }

  clear(): void {
    this.#entries.clear()
  }
}

export async function readCoverDataUrl(
  trackPath: string,
  cache: CoverCache
): Promise<string | null> {
  const cached = cache.get(trackPath)
  if (cached !== undefined) return cached

  try {
    const metadata = await parseFile(trackPath, { skipCovers: false })
    const picture = selectCover(metadata.common.picture)
    const dataUrl = picture
      ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`
      : null
    cache.set(trackPath, dataUrl)
    return dataUrl
  } catch {
    cache.set(trackPath, null)
    return null
  }
}
