import { parseFile, selectCover } from 'music-metadata'

const MAX_CACHED_COVERS = 64

/** Largest embedded picture accepted into cache or onto the wire (12 MB). */
export const MAX_COVER_BYTES = 12 * 1024 * 1024

/** Total cached cover budget (64 MB): count caps stragglers, bytes cap bulk. */
export const MAX_CACHED_COVER_BYTES = 64 * 1024 * 1024

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
 * fills slowly in practice; the budget keeps hostile files from pinning bulk
 * memory (64 entries by count, 64 MB by bytes — oldest evicted first).
 *
 * Entries are raw bytes, not data URLs: base64 inflates images ~33% and forced
 * a decode on every serve. The data-URL form is built only at the IPC boundary
 * that needs it (desktop `<img>` tags); the LAN server streams bytes directly.
 */
export interface CoverImage {
  readonly mime: string
  readonly bytes: Buffer
}

export class CoverCache {
  readonly #entries = new Map<string, CoverImage | null>()
  readonly #sizes = new Map<string, number>()
  #bytes = 0
  readonly #maxBytes: number

  constructor(maxBytes: number = MAX_CACHED_COVER_BYTES) {
    this.#maxBytes = maxBytes
  }

  /** `undefined` means never looked up, `null` means known to have no artwork. */
  get(path: string): CoverImage | null | undefined {
    return this.#entries.get(path)
  }

  set(path: string, image: CoverImage | null): void {
    const previous = this.#sizes.get(path)
    if (previous !== undefined) {
      this.#bytes -= previous
      this.#sizes.delete(path)
      this.#entries.delete(path)
    }
    if (image === null) {
      this.#entries.set(path, null)
      this.#sizes.set(path, 0)
      return
    }
    const size = image.bytes.length
    // Evict oldest-first until the newcomer fits; the count cap catches
    // swarms of tiny entries the byte budget would never notice.
    while (
      (this.#bytes + size > this.#maxBytes || this.#entries.size >= MAX_CACHED_COVERS) &&
      this.#entries.size > 0
    ) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#bytes -= this.#sizes.get(oldest.value) ?? 0
      this.#sizes.delete(oldest.value)
      this.#entries.delete(oldest.value)
    }
    this.#entries.set(path, image)
    this.#sizes.set(path, size)
    this.#bytes += size
  }

  get size(): number {
    return this.#entries.size
  }

  clear(): void {
    this.#entries.clear()
    this.#sizes.clear()
    this.#bytes = 0
  }
}

export async function readCoverBytes(
  trackPath: string,
  cache: CoverCache
): Promise<CoverImage | null> {
  const cached = cache.get(trackPath)
  if (cached !== undefined) return cached

  try {
    const metadata = await parseFile(trackPath, { skipCovers: false })
    const picture = selectCover(metadata.common.picture)
    const mime = picture ? normalizeCoverMime(picture.format) : null
    // Unbounded pictures balloon the cache and every cover response; refuse
    // the absurd ones outright (a 12 MB JPEG is already far past artwork).
    const image =
      picture && mime && picture.data.length <= MAX_COVER_BYTES
        ? { mime, bytes: Buffer.from(picture.data) }
        : null
    cache.set(trackPath, image)
    return image
  } catch {
    cache.set(trackPath, null)
    return null
  }
}

export async function readCoverDataUrl(
  trackPath: string,
  cache: CoverCache
): Promise<string | null> {
  const image = await readCoverBytes(trackPath, cache)
  return image ? `data:${image.mime};base64,${image.bytes.toString('base64')}` : null
}
