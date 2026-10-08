import { parseFile, selectCover } from 'music-metadata'

const MAX_CACHED_COVERS = 64

/**
 * Cover MIME allowlist. Embedded pictures come from untrusted file bytes, so
 * anything outside this set (notably `text/html`) is dropped rather than
 * served — a hostile type served as-is would script in server origin when a
 * phone navigates to the cover URL directly.
 */
export const ALLOWED_COVER_MIME: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
])

/** Normalizes an embedded picture format to a servable MIME, or null. */
export function normalizeCoverMime(format: string): string | null {
  const mime = format.toLowerCase().trim()
  // Writers in the wild use the non-standard alias; browsers render it, and
  // serving it under the canonical name keeps the allowlist exact.
  if (mime === 'image/jpg') return 'image/jpeg'
  return ALLOWED_COVER_MIME.has(mime) ? mime : null
}

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
    const mime = picture ? normalizeCoverMime(picture.format) : null
    const dataUrl =
      picture && mime
        ? `data:${mime};base64,${Buffer.from(picture.data).toString('base64')}`
        : null
    cache.set(trackPath, dataUrl)
    return dataUrl
  } catch {
    cache.set(trackPath, null)
    return null
  }
}
