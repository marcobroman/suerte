import { createHash, randomBytes } from 'node:crypto'
import { MINUTE_MS } from '@shared/types'
import type { DeviceInfo, DeviceRecord, ServerSession } from '@shared/types'
import { sessionAlive, type AuthResult, type CredentialStores, type SessionRecord, type StoredDevice } from './auth'

/** Dirty store writes, throttled so routine activity does not rewrite the
 * config file on every request. Shared by the session and device flush. */
const STORE_FLUSH_THROTTLE_MS = MINUTE_MS

/** Pairing codes live 10 minutes and are typed by hand as a fallback, so the
 * alphabet skips ambiguous characters (0/O, 1/I/L). 9 chars ≈ 45 bits —
 * far past online guessing inside a 10-minute single-use window. */
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const PAIRING_CODE_TTL_MS = 10 * MINUTE_MS
/** Outstanding codes cap: a stuck-open QR screen must not accumulate codes without bound. */
const MAX_PAIRING_CODES = 10
/** Raw bytes per pairing code (mapped through the alphabet, ≈45 bits). */
const PAIRING_CODE_BYTES = 9
/** Raw bytes per hex token (server token, session id, device token). */
const SERVER_TOKEN_BYTES = 32

/** Mints a hex token of the standard server-token size. */
export function mintTokenHex(bytes: number = SERVER_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('hex')
}

/** Short-lived single-use pairing code minted for the QR/link flow. */
export interface PairingCode {
  readonly code: string
  readonly expiresAt: number
}

/** Opaque device id for the settings UI: identifies for revoke, useless for login. */
function deviceId(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface CredentialsDeps {
  getSessions(): readonly ServerSession[]
  saveSessions(sessions: readonly ServerSession[]): Promise<void>
  getDevices(): readonly DeviceRecord[]
  saveDevices(devices: readonly DeviceRecord[]): Promise<void>
  dropSubscribers(predicate: (auth: Exclude<AuthResult, null>) => boolean): void
}

/**
 * Owns every credential store: sessions, devices, and pairing codes, with
 * their persistence and lifetimes. createLibraryServer holds one instance
 * and delegates; auth helpers receive the instance itself as their
 * CredentialStores (same maps, dirty flags routed back through callbacks).
 */
export class CredentialsStore implements CredentialStores {
  // Issued session id → record. Seeded from persisted config at startup;
  // every issue persists, so restarts keep phones logged in. Expired entries
  // die lazily on use (plus a sweep on issue) and persist throttled.
  readonly sessions: Map<string, SessionRecord>
  // Device token → record. Seeded from persisted config; membership changes
  // (pair, revoke, drop) persist immediately, while last-seen activity
  // persists throttled so every request does not rewrite the config file.
  // Mutable internally; snapshots go out through persistDevices/getDevices.
  readonly devices: Map<string, StoredDevice>
  // Outstanding pairing codes → creation time. In-memory only: a restart
  // invalidates a displayed QR, and the desktop simply mints a fresh one.
  private readonly pairings = new Map<string, number>()
  private sessionsDirty = false
  private lastSessionsPersist = 0
  private lastDevicesPersist = 0
  private devicesDirty = false

  constructor(private readonly deps: CredentialsDeps) {
    this.sessions = new Map<string, SessionRecord>(
      deps.getSessions().map((session) => [session.id, { createdAt: session.createdAt, lastSeen: session.lastSeen }])
    )
    this.devices = new Map<string, StoredDevice>(
      deps.getDevices().map((device) => [device.token, { ...device }])
    )
  }

  markSessionsDirty(): void {
    this.sessionsDirty = true
  }

  markDevicesDirty(): void {
    this.devicesDirty = true
  }

  private async persistSessions(): Promise<void> {
    this.lastSessionsPersist = Date.now()
    const rows: ServerSession[] = [...this.sessions].map(([id, record]) => ({
      id,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen
    }))
    await this.deps.saveSessions(rows)
  }

  /**
   * Writes dirty session/device stores, throttled so routine activity does
   * not rewrite the config file on every request. Bookkeeping must never
   * fail a media request, so persistence failures are swallowed here.
   */
  private async flushDirtyStores(): Promise<void> {
    const now = Date.now()
    if (this.sessionsDirty && now - this.lastSessionsPersist > STORE_FLUSH_THROTTLE_MS) {
      this.sessionsDirty = false
      try {
        await this.persistSessions()
      } catch {
        // Best effort, as above.
      }
    }
    if (this.devicesDirty && now - this.lastDevicesPersist > STORE_FLUSH_THROTTLE_MS) {
      this.devicesDirty = false
      try {
        await this.persistDevices()
      } catch {
        // Best effort, as above.
      }
    }
  }

  private async persistDevices(): Promise<void> {
    this.lastDevicesPersist = Date.now()
    await this.deps.saveDevices([...this.devices.values()])
  }

  sweepPairings(now: number = Date.now()): void {
    for (const [code, issuedAt] of this.pairings) {
      if (now - issuedAt > PAIRING_CODE_TTL_MS) this.pairings.delete(code)
    }
    // A stuck-open QR screen must not accumulate codes without bound.
    while (this.pairings.size > MAX_PAIRING_CODES) {
      const oldest = this.pairings.keys().next()
      if (oldest.done) break
      this.pairings.delete(oldest.value)
    }
  }

  /** Reads a pairing code's issue time without consuming it; the exchange burns it after validation. */
  peekPairing(code: string): number | undefined {
    return this.pairings.get(code)
  }

  /** Invalidates one outstanding pairing code (desktop hid its QR). Unknown
   * or already-consumed codes report false; both are safe no-ops. */
  burnPairingCode(code: string): boolean {
    return this.pairings.delete(code)
  }

  /**
   * Mints a single-use pairing code. The code (not the master token) is what
   * the QR and copy-link carry, so the secret never leaves the desktop.
   */
  issuePairingCode(): PairingCode {
    this.sweepPairings()
    const bytes = randomBytes(PAIRING_CODE_BYTES)
    let code = ''
    for (const byte of bytes) {
      const char = PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
      code += char ?? ''
    }
    const now = Date.now()
    this.pairings.set(code, now)
    return { code, expiresAt: now + PAIRING_CODE_TTL_MS }
  }

  /** Records a freshly paired device and persists the membership change. */
  async registerDevice(token: string, name: string, now: number): Promise<void> {
    this.devices.set(token, { token, name, createdAt: now, lastSeen: now })
    await this.persistDevices()
  }

  /** Issues a session id: reaps expired sessions first so the store cannot
   * grow stale entries without bound; the persist writes the swept set. */
  async issueSession(): Promise<string> {
    // Reap expired sessions with the issue so the store cannot grow stale
    // entries without bound; the persist below writes the swept set.
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      if (!sessionAlive(session, now)) this.sessions.delete(id)
    }
    this.sessionsDirty = false
    const id = mintTokenHex()
    this.sessions.set(id, { createdAt: now, lastSeen: now })
    await this.persistSessions()
    // An expired device knocking above was just reaped in memory; write that
    // through now rather than leaving the corpse in config.
    if (this.devicesDirty) {
      this.devicesDirty = false
      try {
        await this.persistDevices()
      } catch {
        // Best effort: the in-memory delete is what authorizes.
      }
    }
    return id
  }

  /** Revokes one session; the caller still clears the cookie. */
  async revokeSession(id: string): Promise<void> {
    this.sessions.delete(id)
    await this.persistSessions()
  }

  /** Revokes one device token entirely. */
  async revokeDeviceToken(token: string): Promise<void> {
    this.devices.delete(token)
    await this.persistDevices()
  }

  /**
   * Fresh activity slides both idle windows, persisted throttled so
   * routine requests do not rewrite the config file every time. Records
   * were liveness-checked in authorized(), so the lookups cannot miss.
   */
  async noteActivity(auth: Exclude<AuthResult, null>): Promise<void> {
    if (auth.kind === 'device') {
      const record = this.devices.get(auth.token)
      if (record) {
        record.lastSeen = Date.now()
        this.devicesDirty = true
      }
    }
    if (auth.kind === 'session') {
      const session = this.sessions.get(auth.id)
      if (session) {
        session.lastSeen = Date.now()
        this.sessionsDirty = true
      }
    }
    await this.flushDirtyStores()
  }

  /** Forgets every issued session (token rotation); persisted too. */
  async dropSessions(): Promise<void> {
    this.sessions.clear()
    this.deps.dropSubscribers((auth) => auth.kind === 'session')
    await this.persistSessions()
  }

  /** Paired devices for the desktop settings list. */
  getDevices(): DeviceInfo[] {
    return [...this.devices.values()].map((record) => ({
      id: deviceId(record.token),
      name: record.name,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen
    }))
  }

  /** Revokes one device by its id; unknown ids report false. */
  async revokeDevice(id: string): Promise<boolean> {
    for (const [token] of this.devices) {
      if (deviceId(token) === id) {
        this.devices.delete(token)
        this.deps.dropSubscribers((auth) => auth.kind === 'device' && auth.token === token)
        await this.persistDevices()
        return true
      }
    }
    return false
  }

  /** Forgets every device and pending code (token rotation); persisted too. */
  async dropDevices(): Promise<void> {
    this.devices.clear()
    this.pairings.clear()
    this.deps.dropSubscribers((auth) => auth.kind === 'device')
    await this.persistDevices()
  }
}
