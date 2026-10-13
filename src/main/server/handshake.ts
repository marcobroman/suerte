import type { IncomingMessage } from 'node:http'
import { MINUTE_MS, SECOND_MS } from '@shared/types'
import { bucketIp } from './net'

/**
 * Handshake endpoints (`/api/session`, `/api/pair`) accept secrets, so they
 * get a per-IP token bucket: 10 attempts per minute, then 429. The secrets
 * themselves are unguessable (256-bit tokens, 45-bit single-use codes), so
 * this is a backstop against scripting and socket-hoarding, not the primary
 * defense. State lives per server instance and resets on restart.
 */
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = MINUTE_MS

export function handshakeAllowed(
  seen: Map<string, { count: number; resetAt: number }>,
  request: IncomingMessage,
  now: number = Date.now()
): { ok: true } | { ok: false; retryAfterSec: number } {
  // One bucket per peer: fold IPv6-mapped IPv4 (`::ffff:1.2.3.4`) onto the
  // address it is, or one stack split-brains the limit.
  const ip = bucketIp(request)
  if (seen.size > 1024) {
    for (const [key, entry] of seen) {
      if (now >= entry.resetAt) seen.delete(key)
    }
  }
  const entry = seen.get(ip)
  if (!entry || now >= entry.resetAt) {
    seen.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return { ok: true }
  }
  entry.count += 1
  if (entry.count > RATE_LIMIT_MAX) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }
  return { ok: true }
}

/** Login cookie name. HttpOnly so page JS can never steal it; SameSite=Strict
 * so cross-site pages cannot ride it. (`Secure` arrives with TLS in Phase 3 —
 * plain HTTP on the LAN cannot set it.) */
export const SESSION_COOKIE = 'onda_session'

/**
 * A dripped handshake body must not idle forever: 10 seconds for 4 KB is
 * generous to slow phones and fatal to slow-drip scripts. Separate name
 * from the headers timeout on purpose — same value, different budget.
 */
const BODY_TIMEOUT_MS = 10 * SECOND_MS

/** Null unless the request carries a syntactically valid session id. */
export function sessionIdOf(request: IncomingMessage): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (!trimmed.startsWith(`${SESSION_COOKIE}=`)) continue
    const value = trimmed.slice(SESSION_COOKIE.length + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/** Reads a small request body, or null when it is missing, oversized, or unreadable. */
export function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (body: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(body)
    }
    // A dripped body must not idle forever: 10 seconds for 4 KB is generous
    // to slow phones and fatal to slow-drip scripts.
    const timer = setTimeout(() => {
      request.destroy()
      finish(null)
    }, BODY_TIMEOUT_MS)
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => finish(null))
  })
}
