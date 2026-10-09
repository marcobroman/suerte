import type { DiscogsCandidate, DiscogsRelease, DiscogsTrack } from '@shared/types'
import type { DiscogsErrorKind } from '@shared/ipc'
import { normalizeCoverMime } from './library/covers'

export class DiscogsError extends Error {
  readonly kind: DiscogsErrorKind

  constructor(kind: DiscogsErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export interface DiscogsArt {
  readonly mime: string
  readonly data: Uint8Array
}

export interface DiscogsClientOptions {
  readonly token: string
  /** Minimum gap between requests; production stays polite, tests pass 0. */
  readonly throttleMs?: number
  readonly fetchImpl?: typeof fetch
}

export interface DiscogsClient {
  searchReleases(query: string): Promise<readonly DiscogsCandidate[]>
  getRelease(id: number, kind: 'master' | 'release'): Promise<DiscogsRelease>
  fetchArt(url: string): Promise<DiscogsArt>
}

const API_ROOT = 'https://api.discogs.com'
const USER_AGENT = 'Equalizer/0.1.0 (desktop music player)'
const DEFAULT_THROTTLE_MS = 1100

/** Shared across instances so rapid successive dialogs stay under the limit. */
let lastCallAt = 0

async function pace(throttleMs: number): Promise<void> {
  const wait = lastCallAt + throttleMs - Date.now()
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
  lastCallAt = Date.now()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/** Search hits arrive as "Artist – Title"; the release fetch is authoritative. */
function splitArtistTitle(combined: string): { artist: string; title: string } {
  for (const separator of [' - ', ' – ']) {
    const at = combined.indexOf(separator)
    if (at > 0) {
      return {
        artist: combined.slice(0, at).trim(),
        title: combined.slice(at + separator.length).trim()
      }
    }
  }
  return { artist: '', title: combined.trim() }
}

/** Discogs disambiguates artists as "Name (2)"; tags should carry the plain name. */
function plainArtistName(name: string): string {
  return name.replace(/\s\(\d+\)$/, '').trim()
}

function firstString(values: unknown): string {
  if (typeof values === 'string') return values
  if (!Array.isArray(values)) return ''
  const first = values[0]
  if (typeof first === 'string') return first
  return asString(asRecord(first)?.['name']) ?? ''
}

export function createDiscogsClient(options: DiscogsClientOptions): DiscogsClient {
  const token = options.token.trim()
  if (token === '') {
    throw new DiscogsError('missing-token', 'Add a Discogs token in Settings first.')
  }
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS
  const fetchImpl = options.fetchImpl ?? fetch

  async function request(url: string): Promise<unknown> {
    await pace(throttleMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Authorization: `Discogs token=${token}` }
      })
    } catch (error: unknown) {
      throw new DiscogsError(
        'network',
        error instanceof Error ? error.message : 'Discogs is unreachable.'
      )
    }
    if (response.status === 401 || response.status === 403) {
      throw new DiscogsError('unauthorized', 'Discogs rejected the token.')
    }
    if (response.status === 404) throw new DiscogsError('not-found', 'Not found on Discogs.')
    if (response.status === 429) {
      throw new DiscogsError('rate-limited', 'Discogs rate limit hit — try again shortly.')
    }
    if (!response.ok) throw new DiscogsError('network', `Discogs answered ${response.status}.`)
    try {
      return (await response.json()) as unknown
    } catch {
      throw new DiscogsError('network', 'Discogs answered with invalid data.')
    }
  }

  return {
    async searchReleases(query: string): Promise<readonly DiscogsCandidate[]> {
      const needle = query.trim()
      if (needle === '') return []
      const url =
        `${API_ROOT}/database/search?` +
        `q=${encodeURIComponent(needle)}&type=master,release&per_page=20`
      const body = asRecord(await request(url))
      const results = body?.['results']
      if (!Array.isArray(results)) return []
      const candidates: DiscogsCandidate[] = []
      for (const entry of results) {
        const item = asRecord(entry)
        if (!item) continue
        const id = asNumber(item['id'])
        const rawType = asString(item['type'])
        const kind = rawType === 'master' ? 'master' : rawType === 'release' ? 'release' : null
        if (id === null || kind === null) continue
        const { artist, title } = splitArtistTitle(asString(item['title']) ?? '')
        if (title === '') continue
        candidates.push({
          id: Math.trunc(id),
          kind,
          title,
          artist,
          year: asNumber(item['year']),
          label: firstString(item['label']),
          thumbUrl: asString(item['thumb'] ?? item['cover_image'])
        })
      }
      return candidates
    },

    async getRelease(id: number, kind: 'master' | 'release'): Promise<DiscogsRelease> {
      const body = asRecord(await request(`${API_ROOT}/${kind}s/${id}`))
      if (!body) throw new DiscogsError('not-found', 'Not found on Discogs.')
      const artists = body['artists']
      const names: string[] = []
      if (Array.isArray(artists)) {
        for (const entry of artists) {
          const name = asString(asRecord(entry)?.['name'])
          if (name) names.push(plainArtistName(name))
        }
      }
      const tracks: DiscogsTrack[] = []
      const tracklist = body['tracklist']
      if (Array.isArray(tracklist)) {
        for (const entry of tracklist) {
          const item = asRecord(entry)
          if (!item || asString(item['type_']) === 'heading') continue
          const title = (asString(item['title']) ?? '').trim()
          if (title === '') continue
          tracks.push({
            position: (asString(item['position']) ?? '').trim(),
            title,
            duration: asString(item['duration'])
          })
        }
      }
      const images = body['images']
      let coverUrl: string | null = null
      if (Array.isArray(images)) {
        const primary = images.find(
          (entry) => asString(asRecord(entry)?.['type']) === 'primary'
        )
        const picked = primary ?? images[0]
        coverUrl = asString(asRecord(picked)?.['uri'] ?? asRecord(picked)?.['resource_url'])
      }
      return {
        id,
        kind,
        artist: names.join(', '),
        title: (asString(body['title']) ?? '').trim(),
        year: asNumber(body['year']),
        label: firstString(body['labels'] ?? body['label']),
        tracks,
        coverUrl
      }
    },

    async fetchArt(url: string): Promise<DiscogsArt> {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new DiscogsError('network', 'That cover URL is invalid.')
      }
      // HTTPS-only on the Discogs CDN: no downgrade to sniffable HTTP, no
      // off-CDN hosts. SVG is excluded by the MIME allowlist below — vector
      // formats script, and cover art is always raster.
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.discogs.com')) {
        throw new DiscogsError('network', 'That cover URL is invalid.')
      }
      await pace(throttleMs)
      let response: Response
      try {
        response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } })
      } catch (error: unknown) {
        throw new DiscogsError(
          'network',
          error instanceof Error ? error.message : 'Cover download failed.'
        )
      }
      if (!response.ok) throw new DiscogsError('network', 'Cover download failed.')
      const mime = normalizeCoverMime((response.headers.get('content-type') ?? '').split(';')[0] ?? '')
      if (!mime) throw new DiscogsError('network', 'That URL is not a supported image.')
      return { mime, data: new Uint8Array(await response.arrayBuffer()) }
    }
  }
}
