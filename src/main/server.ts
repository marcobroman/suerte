import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import type { LibrarySummary, PublicLibrarySummary } from '@shared/ipc'
import type { Track } from '@shared/types'
import { extensionOf } from '@shared/audio-files'

export interface LibraryServerDeps {
  /** Read live so port changes apply without rebuilding the server. */
  getPort(): number
  getToken(): string | undefined
  getSummary(): LibrarySummary
  readCover(path: string): Promise<string | null>
  getRoots(): readonly string[]
  /** Built renderer directory, or null when it was never built (dev mode). */
  getClientDir(): string | null
}

export interface LibraryServer {
  readonly listening: boolean
  /** Resolves the reachable base URL, or rejects when the port is taken. */
  start(): Promise<string>
  stop(): Promise<void>
  /** Pushes the current summary to every SSE subscriber. */
  pushLibraryChanged(): void
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.ape': 'audio/ape',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm'
}

/** First LAN IPv4, for the "open this on your phone" display. Loopback excluded. */
export function lanBaseUrl(port: number): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return `http://${address.address}:${port}`
      }
    }
  }
  return null
}

/**
 * True when the requested path is a library root itself or lives under one.
 * relative() collapses `..` lexically, so anything escaping a root starts
 * with `..` (or resolves absolute on another drive) and is rejected.
 */
export function insideRoots(roots: readonly string[], candidate: string): boolean {
  const normalized = normalize(candidate)
  for (const root of roots) {
    const rel = relative(root, normalized)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/**
 * Opaque track id: a one-way hash of the absolute path. Deterministic, so it
 * survives rescans and restarts, and irreversible, so absolute paths (drives,
 * usernames, folder layout) never leave the machine. Remote clients use ids
 * everywhere local code uses paths.
 */
export function trackId(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

const CLIENT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

/** Pinned inside the client dir: `..` collapses lexically, so escapes fail the prefix check. Exported for tests. */
export function clientPathIn(clientDir: string, requestPath: string): string | null {
  // resolve() absolutizes and normalizes both sides alike, so a relative base
  // and mixed separators compare correctly on every platform.
  const base = resolve(clientDir)
  const resolved = resolve(base, `.${requestPath}`)
  // The separator-joined prefix keeps a sibling like `<dir>-other` out.
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) return null
  return resolved
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  })
  response.end(payload)
}

export function createLibraryServer(deps: LibraryServerDeps): LibraryServer {
  let server: Server | null = null
  let listening = false
  let boundPort = 0
  const events = new Set<ServerResponse>()
  // Opaque id → real path, rebuilt only when the track list itself is replaced
  // (i.e. on rescan); lookups in between are map hits.
  let idCache: { tracks: readonly Track[]; byId: Map<string, string> } | null = null

  function resolveTrackId(id: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(id)) return null
    const tracks = deps.getSummary().tracks
    if (!idCache || idCache.tracks !== tracks) {
      const byId = new Map<string, string>()
      for (const track of tracks) byId.set(trackId(track.path), track.path)
      idCache = { tracks, byId }
    }
    return idCache.byId.get(id) ?? null
  }

  function publicSummary(): PublicLibrarySummary {
    const summary = deps.getSummary()
    const idByPath = new Map<string, string>()
    const idOf = (path: string): string => {
      const existing = idByPath.get(path)
      if (existing) return existing
      const id = trackId(path)
      idByPath.set(path, id)
      return id
    }
    return {
      tree: {
        artists: summary.tree.artists,
        albums: summary.tree.albums.map((album) => ({
          ...album,
          trackPaths: album.trackPaths.map(idOf)
        }))
      },
      tracks: summary.tracks.map((track) => ({ ...track, path: idOf(track.path) })),
      trackCount: summary.trackCount,
      scanning: summary.scanning
    }
  }

  function authorized(request: IncomingMessage, url: URL): boolean {
    const token = deps.getToken()
    if (!token) return false
    const header = request.headers.authorization
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length) === token
    // <audio> and <img> tags cannot set headers, so media URLs carry it instead.
    return url.searchParams.get('token') === token
  }

  async function serveStream(path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let size: number
    try {
      const stats = await fs.stat(path)
      if (!stats.isFile()) {
        json(response, 404, { error: 'not an audio file' })
        return
      }
      size = stats.size
    } catch {
      json(response, 404, { error: 'not found' })
      return
    }

    const mime = AUDIO_MIME[extensionOf(path)] ?? 'application/octet-stream'
    const range = request.headers.range
    if (!range) {
      response.writeHead(200, {
        'content-type': mime,
        'content-length': size,
        'accept-ranges': 'bytes'
      })
      createReadStream(path).pipe(response)
      return
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match) {
      response.writeHead(416, { 'content-range': `bytes */${size}` })
      response.end()
      return
    }
    const startText = match[1]
    const endText = match[2]
    let start: number
    let end: number
    if (startText === '') {
      // Suffix range: the last N bytes.
      const count = Number(endText)
      if (endText === '' || !Number.isFinite(count) || count <= 0) {
        response.writeHead(416, { 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      start = Math.max(0, size - Math.trunc(count))
      end = size - 1
    } else {
      start = Number(startText)
      end = endText === '' ? size - 1 : Number(endText)
      if (!Number.isFinite(start) || start < 0 || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` })
        response.end()
        return
      }
      if (!Number.isFinite(end) || end < start) end = size - 1
      if (end >= size) end = size - 1
    }

    response.writeHead(206, {
      'content-type': mime,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes'
    })
    createReadStream(path, { start, end }).pipe(response)
  }

  async function serveCover(path: string, response: ServerResponse): Promise<void> {
    const dataUrl = await deps.readCover(path)
    const parsed = dataUrl ? /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl) : null
    if (!parsed?.[1] || !parsed[2]) {
      json(response, 404, { error: 'no cover art' })
      return
    }
    const bytes = Buffer.from(parsed[2], 'base64')
    response.writeHead(200, { 'content-type': parsed[1], 'content-length': bytes.length })
    response.end(bytes)
  }

  async function serveClient(pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const clientDir = deps.getClientDir()
    if (!clientDir) {
      json(response, 404, { error: 'client not built' })
      return
    }
    const sendFile = async (file: string, noStore: boolean): Promise<void> => {
      const headers: Record<string, string> = {
        'content-type': CLIENT_MIME[extensionOf(file)] ?? 'application/octet-stream'
      }
      if (noStore) headers['cache-control'] = 'no-store'
      try {
        const stats = await fs.stat(file)
        if (!stats.isFile()) throw new Error('not a file')
        headers['content-length'] = String(stats.size)
        response.writeHead(200, headers)
        createReadStream(file).pipe(response)
      } catch {
        json(response, 404, { error: 'not found' })
      }
    }
    if (pathname === '/' || pathname === '/index.html') {
      await sendFile(resolve(clientDir, 'index.html'), true)
      return
    }
    const file = clientPathIn(clientDir, pathname)
    if (!file) {
      json(response, 404, { error: 'not found' })
      return
    }
    try {
      const stats = await fs.stat(file)
      if (stats.isFile()) {
        await sendFile(file, false)
        return
      }
    } catch {
      // Missing below: fall through to the SPA fallback when appropriate.
    }
    // Single-page app: navigations outside /api/* load the shell, which routes
    // client-side. Asset-looking misses 404 so stale bundles fail loudly.
    const acceptsHtml = (request.headers.accept ?? '').includes('text/html')
    if (acceptsHtml) {
      await sendFile(resolve(clientDir, 'index.html'), true)
      return
    }
    json(response, 404, { error: 'not found' })
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    // The UI shell is public: a phone must load the page to enter its token.
    // Everything under /api/* requires the token instead.
    if (!url.pathname.startsWith('/api/')) {
      try {
        await serveClient(url.pathname, request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'request failed' })
        else response.end()
      }
      return
    }
    if (!authorized(request, url)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }

    if (url.pathname === '/api/library') {
      json(response, 200, publicSummary())
      return
    }
    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      response.flushHeaders()
      events.add(response)
      request.on('close', () => {
        events.delete(response)
      })
      return
    }
    if (url.pathname === '/api/stream' || url.pathname === '/api/cover') {
      const id = url.searchParams.get('id')
      if (!id) {
        json(response, 400, { error: 'missing id' })
        return
      }
      // Opaque ids cannot traverse by construction; the resolved real path is
      // still containment-checked as defense in depth.
      const real = resolveTrackId(id)
      if (!real || !insideRoots(deps.getRoots(), real)) {
        json(response, 404, { error: 'not found' })
        return
      }
      try {
        if (url.pathname === '/api/cover') await serveCover(real, response)
        else await serveStream(real, request, response)
      } catch {
        if (!response.headersSent) json(response, 500, { error: 'stream failed' })
        else response.end()
      }
      return
    }
    json(response, 404, { error: 'unknown endpoint' })
  }

  return {
    get listening() {
      return listening
    },

    start(): Promise<string> {
      if (server) return Promise.resolve(`http://localhost:${boundPort}`)
      return new Promise((resolve, reject) => {
        const next = createServer((request, response) => {
          void handle(request, response)
        })
        next.on('error', (error: unknown) => {
          reject(error instanceof Error ? error : new Error('server failed to start'))
        })
        next.listen(deps.getPort(), '0.0.0.0', () => {
          server = next
          listening = true
          const address = next.address()
          boundPort = typeof address === 'object' && address ? address.port : deps.getPort()
          resolve(`http://localhost:${boundPort}`)
        })
      })
    },

    stop(): Promise<void> {
      for (const client of events) {
        try {
          client.end()
        } catch {
          // A dead subscriber must never block shutdown.
        }
      }
      events.clear()
      const closing = server
      server = null
      listening = false
      boundPort = 0
      if (!closing) return Promise.resolve()
      return new Promise((resolve) => closing.close(() => resolve()))
    },

    pushLibraryChanged(): void {
      if (events.size === 0) return
      const payload = `data: ${JSON.stringify(publicSummary())}\n\n`
      for (const client of [...events]) {
        try {
          client.write(payload)
        } catch {
          events.delete(client)
        }
      }
    }
  }
}
