import { createReadStream, promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { extensionOf } from '@shared/audio-files'
import { ALLOWED_COVER_MIME, MAX_COVER_BYTES, type CoverImage } from '../library/covers'
import { clientPathIn } from './paths'
import { json } from './respond'

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

export async function serveStream(
  path: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
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
    pipeFile(path, null, request, response)
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
  pipeFile(path, { start, end }, request, response)
}

/**
 * Pipes a file to the response without letting filesystem races crash the
 * main process: a file deleted or locked mid-stream ends the response
 * instead of throwing uncaught, and a dropped client destroys the stream
 * instead of leaking its handle.
 */
function pipeFile(
  path: string,
  options: { start: number; end: number } | null,
  request: IncomingMessage,
  response: ServerResponse
): void {
  const stream = options ? createReadStream(path, options) : createReadStream(path)
  stream.on('error', () => {
    if (!response.headersSent) json(response, 500, { error: 'stream failed' })
    else response.end()
  })
  request.on('close', () => stream.destroy())
  stream.pipe(response)
}

export async function serveCover(
  path: string,
  response: ServerResponse,
  readCover: (path: string) => Promise<CoverImage | null>
): Promise<void> {
  const image = await readCover(path)
  // Defense in depth: extraction already filters, but a hostile MIME must
  // never reach the wire even if a future reader is lax. Non-images 404.
  if (!image || !ALLOWED_COVER_MIME.has(image.mime)) {
    json(response, 404, { error: 'no cover art' })
    return
  }
  if (image.bytes.length > MAX_COVER_BYTES) {
    json(response, 404, { error: 'no cover art' })
    return
  }
  response.writeHead(200, {
    'content-type': image.mime,
    'content-length': image.bytes.length,
    // Even an allowed image must not sniff or script: a direct navigation
    // to this URL renders in server origin.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer'
  })
  response.end(image.bytes)
}

export async function serveClient(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  clientDir: string | null
): Promise<void> {
  if (!clientDir) {
    json(response, 404, { error: 'client not built' })
    return
  }
  const sendFile = async (file: string, noStore: boolean, size?: number): Promise<void> => {
    const headers: Record<string, string> = {
      'content-type': CLIENT_MIME[extensionOf(file)] ?? 'application/octet-stream'
    }
    if (noStore) headers['cache-control'] = 'no-store'
    try {
      const length =
        size ??
        (await fs.stat(file).then((stats) => {
          if (!stats.isFile()) throw new Error('not a file')
          return stats.size
        }))
      headers['content-length'] = String(length)
      response.writeHead(200, headers)
      pipeFile(file, null, request, response)
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
      await sendFile(file, false, stats.size)
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
