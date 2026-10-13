import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MAX_DEVICE_NAME_LENGTH } from '@shared/types'
import type { PublicLibrarySummary } from '@shared/ipc'
import { authorized, secretsEqual, takeLiveDevice, type AuthResult } from './auth'
import { handshakeAllowed, readBody, SESSION_COOKIE } from './handshake'
import { bucketIp } from './net'
import { insideRoots } from './paths'
import { serveCover, serveStream } from './media'
import type { CoverImage } from '../library/covers'
import { json } from './respond'
import type { CredentialsStore } from './credentials'
import { mintTokenHex } from './credentials'
import type { EventHub } from './events'

/** Browser keeps the login ~a year; the server itself never expires sessions. */
const SESSION_MAX_AGE_SEC = 31536000
/** Session handshake bodies are tiny JSON; anything bigger is abuse. */
const SESSION_BODY_LIMIT = 4096

/**
 * Everything endpoint handlers need from createLibraryServer, passed
 * explicitly so routes stay testable without HTTP. Live getters (token,
 * TLS, roots, summary) route back through it.
 */
export interface RouterContext {
  credentials: CredentialsStore
  hub: EventHub
  getMasterToken(): string | undefined
  getTls(): { cert: string; key: string } | null
  getRoots(): readonly string[]
  readCover(path: string): Promise<CoverImage | null>
  getClientDir(): string | null
  resolveTrackId(id: string): string | null
  publicSummary(): PublicLibrarySummary
  tlsFingerprint(): string | null
  handshakeAttempts: Map<string, { count: number; resetAt: number }>
}

async function handleSession(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RouterContext
): Promise<void> {
  const token = ctx.getMasterToken()
  const header = request.headers.authorization
  const presented =
    header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  let bodyToken: string | null = null
  if (presented === null) {
    const raw = await readBody(request, SESSION_BODY_LIMIT)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>
        bodyToken = typeof parsed['token'] === 'string' ? parsed['token'] : null
      } catch {
        bodyToken = null
      }
    }
  }
  const credential = presented ?? bodyToken
  // The master token logs in, and so does any paired device token — a phone
  // that paired yesterday must be able to open a session with the only
  // credential it kept. An idle-expired device cannot mint sessions.
  const known =
    token !== undefined &&
    credential !== null &&
    (secretsEqual(credential, token) ||
      takeLiveDevice(ctx.credentials, credential, Date.now()) !== null)
  if (!token || !known) {
    json(response, 401, { error: 'unauthorized' })
    return
  }
  const id = await ctx.credentials.issueSession()
  // `Secure` only when the transport is TLS — plain HTTP cannot set it,
  // and a cookie without it never leaves a secure origin anyway.
  const cookieSecure = ctx.getTls() ? '; Secure' : ''
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'set-cookie': `${SESSION_COOKIE}=${id}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SEC}${cookieSecure}`
  })
  response.end(JSON.stringify({ ok: true }))
}

async function handlePair(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RouterContext
): Promise<void> {
  ctx.credentials.sweepPairings()
  const raw = await readBody(request, SESSION_BODY_LIMIT)
  let code: unknown = null
  let name: unknown = null
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      code = parsed['code']
      name = parsed['name']
    } catch {
      code = null
    }
  }
  const trimmedName = typeof name === 'string' ? name.trim() : ''
  if (trimmedName === '' || trimmedName.length > MAX_DEVICE_NAME_LENGTH) {
    json(response, 400, { error: `a device name up to ${MAX_DEVICE_NAME_LENGTH} characters is required` })
    return
  }
  const issuedAt = typeof code === 'string' ? ctx.credentials.peekPairing(code) : undefined
  if (typeof code !== 'string' || issuedAt === undefined) {
    json(response, 401, { error: 'unauthorized' })
    return
  }
  ctx.credentials.burnPairingCode(code)
    const token = mintTokenHex()
  const now = Date.now()
  await ctx.credentials.registerDevice(token, trimmedName, now)
  json(response, 200, { token })
}

async function handleHandshake(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: RouterContext,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<void> {
  if (request.method !== 'POST') {
    json(response, 405, { error: 'method not allowed' })
    return
  }
  const limit = handshakeAllowed(ctx.handshakeAttempts, request)
  if (!limit.ok) {
    response.setHeader('retry-after', String(limit.retryAfterSec))
    json(response, 429, { error: 'too many attempts' })
    return
  }
  try {
    await handler(request, response)
  } catch {
    if (!response.headersSent) json(response, 500, { error: 'request failed' })
    else response.end()
  }
}

async function handleLogout(
  response: ServerResponse,
  auth: Exclude<AuthResult, null>,
  ctx: RouterContext
): Promise<void> {
  try {
    if (auth.kind === 'session') {
      await ctx.credentials.revokeSession(auth.id)
    } else if (auth.kind === 'device') {
      await ctx.credentials.revokeDeviceToken(auth.token)
    }
  } catch {
    // The cookie clearing below still logs the browser out; the
    // in-memory deletes are what authorize.
  }
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    // Mirror the login cookie's flags exactly, or strict browsers keep
    // the (revoked) Secure cookie this is meant to clear.
    'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${ctx.getTls() ? '; Secure' : ''}`
  })
  response.end(JSON.stringify({ ok: true }))
}

/**
 * Routes that authenticate inline or not at all: fingerprint (public
 * identity), logout (revokes its own credential), session and pair (the
 * credential-accepting POSTs). True when answered; the GET-only gate and
 * everything behind it belong to the dispatch below.
 */
export async function routePublic(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: RouterContext
): Promise<boolean> {
  // Public identity: the fingerprint is trust-on-first-use material, not a
  // secret (browsers display it), so phones can bind saved trust to it —
  // no credential required, like the client shell below.
  if (url.pathname === '/api/fingerprint') {
    if (request.method !== 'GET') {
      json(response, 405, { error: 'method not allowed' })
      return true
    }
    json(response, 200, { fingerprint: ctx.tlsFingerprint() })
    return true
  }
  // Logout revokes its own credential, so it authenticates inline here
  // rather than behind the GET-only gate below. A session dies with its
  // cookie, a device dies entirely; the master token has no per-login
  // state (rotating it is its logout), so it just clears the cookie.
  if (url.pathname === '/api/logout') {
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' })
      return true
    }
    const auth = authorized(request, url, ctx.getMasterToken(), ctx.credentials)
    if (!auth) {
      json(response, 401, { error: 'unauthorized' })
      return true
    }
    await handleLogout(response, auth, ctx)
    return true
  }
  // The session handshake is the only POST: it must come before the
  // GET-only gate below, and it answers 405 to anything else.
  if (url.pathname === '/api/session') {
    await handleHandshake(request, response, ctx, (req, res) => handleSession(req, res, ctx))
    return true
  }
  // Pairing consumes its credential instead of presenting one, so like the
  // handshake it sits outside the auth gate — with the same 405 discipline.
  if (url.pathname === '/api/pair') {
    await handleHandshake(request, response, ctx, (req, res) => handlePair(req, res, ctx))
    return true
  }
  return false
}

/**
 * Canonical roots, memoized by roots-array identity (replaced wholesale on
 * folder add/remove, so identity change means re-resolve). Only fully
 * successful resolutions are cached: a reconnecting drive must self-heal on
 * the next request, not stick on a cached omission. The per-FILE realpath
 * below is deliberately NOT cached — it is the TOCTOU defense against
 * symlinks swapped between requests.
 */
const canonicalRootsCache = new WeakMap<readonly string[], string[]>()

async function canonicalRootsFor(roots: readonly string[]): Promise<string[]> {
  const cached = canonicalRootsCache.get(roots)
  if (cached) return cached
  const canonicalRoots: string[] = []
  let complete = true
  for (const root of roots) {
    try {
      canonicalRoots.push(await fs.realpath(root))
    } catch {
      // Unreachable roots cannot contain anything right now.
      complete = false
    }
  }
  if (complete) canonicalRootsCache.set(roots, canonicalRoots)
  return canonicalRoots
}

/**
 * Routes behind the auth gate: the caller authorized already and slid the
 * idle windows. True when answered; unknown /api/* paths 404 in dispatch.
 */
export async function routeAuthed(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  auth: Exclude<AuthResult, null>,
  ctx: RouterContext
): Promise<boolean> {
  if (url.pathname === '/api/library') {
    json(response, 200, ctx.publicSummary())
    return true
  }
  if (url.pathname === '/api/events') {
    // Bounded subscribers: an unbounded Set lets one peer hoard sockets.
    if (ctx.hub.isFull()) {
      json(response, 503, { error: 'too many subscribers' })
      return true
    }
    const subscriberIp = bucketIp(request)
    ctx.hub.subscribe(request, response, subscriberIp, auth)
    return true
  }
  if (url.pathname === '/api/stream' || url.pathname === '/api/cover') {
    const id = url.searchParams.get('id')
    if (!id) {
      json(response, 400, { error: 'missing id' })
      return true
    }
    // Opaque ids cannot traverse by construction; the resolved real path is
    // still containment-checked as defense in depth — twice: lexically,
    // then canonically, so a symlink planted in the library cannot smuggle
    // an outside file past the check (TOCTOU included: the canonical path
    // is what actually gets served).
    const real = ctx.resolveTrackId(id)
    if (!real || !insideRoots(ctx.getRoots(), real)) {
      json(response, 404, { error: 'not found' })
      return true
    }
    let canonical: string
    try {
      canonical = await fs.realpath(real)
      const canonicalRoots = await canonicalRootsFor(ctx.getRoots())
      if (!insideRoots(canonicalRoots, canonical)) throw new Error('outside roots')
    } catch {
      json(response, 404, { error: 'not found' })
      return true
    }
    try {
      if (url.pathname === '/api/cover') await serveCover(canonical, response, ctx.readCover)
      else await serveStream(canonical, request, response)
    } catch {
      if (!response.headersSent) json(response, 500, { error: 'stream failed' })
      else response.end()
    }
    return true
  }
  return false
}
