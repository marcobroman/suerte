import { createReadStream, promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { isAbsolute, normalize, relative } from 'node:path'
import type { LibrarySummary } from '@shared/ipc'
import { extensionOf } from '@shared/audio-files'

export interface LibraryServerDeps {
  /** Read live so port changes apply without rebuilding the server. */
  getPort(): number
  getToken(): string | undefined
  getSummary(): LibrarySummary
  readCover(path: string): Promise<string | null>
  getRoots(): readonly string[]
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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return
    }
    if (!authorized(request, url)) {
      json(response, 401, { error: 'unauthorized' })
      return
    }

    if (url.pathname === '/api/library') {
      json(response, 200, deps.getSummary())
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
      const requested = url.searchParams.get('path')
      if (!requested) {
        json(response, 400, { error: 'missing path' })
        return
      }
      if (!insideRoots(deps.getRoots(), requested)) {
        json(response, 403, { error: 'outside the library' })
        return
      }
      try {
        if (url.pathname === '/api/cover') await serveCover(requested, response)
        else await serveStream(requested, request, response)
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
      const payload = `data: ${JSON.stringify(deps.getSummary())}\n\n`
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
