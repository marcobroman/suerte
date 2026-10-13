import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DAY_MS } from '@shared/types'
import { sessionIdOf } from './handshake'

/**
 * Lifetimes: sessions die 7 days after issue no matter what, or after 24
 * idle hours; devices die 180 days after pairing or after 90 idle days.
 * Abandoned phones fall off by themselves; active ones never notice (the
 * client re-logs-in silently on a stale cookie while its device is valid).
 */
const SESSION_ABSOLUTE_TTL_MS = 7 * DAY_MS
const SESSION_IDLE_TTL_MS = DAY_MS
const DEVICE_ABSOLUTE_TTL_MS = 180 * DAY_MS
const DEVICE_IDLE_TTL_MS = 90 * DAY_MS

/** Which credential authorized a request; null when none did. */
export type AuthResult =
  | { kind: 'master'; token: string }
  | { kind: 'session'; id: string }
  | { kind: 'device'; token: string }
  | null

/** In-memory session record; the session id is the map key. */
export interface SessionRecord {
  createdAt: number
  lastSeen: number
}

/** In-memory device record; the device token is the map key. */
export interface StoredDevice {
  token: string
  name: string
  createdAt: number
  lastSeen: number
}

/**
 * Credential stores owned by the server closure. Auth helpers take these as
 * parameters instead of closing over server state, so they stay unit-testable
 * without HTTP. Dirty markers route through callbacks because the throttle
 * bookkeeping lives with the stores.
 */
export interface CredentialStores {
  readonly sessions: Map<string, SessionRecord>
  readonly devices: Map<string, StoredDevice>
  markSessionsDirty(): void
  markDevicesDirty(): void
}

export function sessionAlive(session: SessionRecord, now: number): boolean {
  return now - session.createdAt <= SESSION_ABSOLUTE_TTL_MS && now - session.lastSeen <= SESSION_IDLE_TTL_MS
}

export function deviceAlive(record: SessionRecord, now: number): boolean {
  return (
    now - record.createdAt <= DEVICE_ABSOLUTE_TTL_MS && now - record.lastSeen <= DEVICE_IDLE_TTL_MS
  )
}

/**
 * Constant-time string compare for secrets. Map lookups stay hash-based;
 * the bearer secret — the one an oracle could target — gets no shortcut.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Returns the live device record for a presented token, or null. Expired
 * records are deleted on sight (persisted throttled), so a phone idle past
 * its window is logged out the next time it knocks.
 */
export function takeLiveDevice(
  stores: CredentialStores,
  token: string,
  now: number
): StoredDevice | null {
  const record = stores.devices.get(token)
  if (!record) return null
  if (!deviceAlive(record, now)) {
    stores.devices.delete(token)
    stores.markDevicesDirty()
    return null
  }
  return record
}

export function authorized(
  request: IncomingMessage,
  url: URL,
  masterToken: string | undefined,
  stores: CredentialStores
): AuthResult {
  const token = masterToken
  if (!token) return null
  const header = request.headers.authorization
  const presented = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : (url.searchParams.get('token') ?? null)
  if (presented === null) {
    // The login cookie is the preferred credential: unlike the query token
    // it never lands in logs, history, or referrers, and <audio>/<img>/
    // EventSource send it automatically on same-origin requests.
    const sessionId = sessionIdOf(request)
    if (sessionId) {
      const session = stores.sessions.get(sessionId)
      if (session) {
        if (!sessionAlive(session, Date.now())) {
          stores.sessions.delete(sessionId)
          stores.markSessionsDirty()
          return null
        }
        return { kind: 'session', id: sessionId }
      }
    }
    return null
  }
  if (secretsEqual(presented, token)) return { kind: 'master', token: presented }
  // <audio> and <img> tags cannot set headers, so media URLs carry the
  // credential instead — a device token works there exactly like the master.
  const record = takeLiveDevice(stores, presented, Date.now())
  return record ? { kind: 'device', token: presented } : null
}
