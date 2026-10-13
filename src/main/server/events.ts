import type { IncomingMessage, ServerResponse } from 'node:http'
import { SECOND_MS } from '@shared/types'
import type { PublicLibrarySummary } from '@shared/ipc'
import {
  secretsEqual,
  sessionAlive,
  takeLiveDevice,
  type AuthResult,
  type CredentialStores
} from './auth'

/** Live event subscribers; beyond this the server answers 503. */
const MAX_EVENT_SUBSCRIBERS = 20
/** Per-IP subscriber cap: one peer cannot hoard the global budget. */
const MAX_EVENT_SUBSCRIBERS_PER_IP = 4
/** SSE keepalive: NATs and proxies drop idle sockets the client cannot see. */
const EVENT_HEARTBEAT_MS = 25 * SECOND_MS

export interface EventSubscriber {
  response: ServerResponse
  ip: string
  auth: Exclude<AuthResult, null>
}

export interface EventHubDeps {
  getMasterToken(): string | undefined
  credentials: CredentialStores
  summarize(): PublicLibrarySummary
}

/**
 * Owns every live SSE subscription: caps, heartbeat, revocation drops, and
 * library pushes. The server closure holds one instance; master-token reads
 * and library snapshots route back through injected getters so the hub never
 * owns library state.
 */
export class EventHub {
  private readonly subs = new Set<EventSubscriber>()
  private heartbeat: NodeJS.Timeout | null = null

  constructor(private readonly deps: EventHubDeps) {}

  /** Global subscriber cap reached: the route answers 503 instead. */
  isFull(): boolean {
    return this.subs.size >= MAX_EVENT_SUBSCRIBERS
  }

  /**
   * Subscribes a response: per-IP cap with oldest-first eviction (a
   * reconnect storm from one peer must not deny live-updates to everyone
   * else), then headers and close wiring.
   */
  subscribe(
    request: IncomingMessage,
    response: ServerResponse,
    ip: string,
    auth: Exclude<AuthResult, null>
  ): void {
    // Per-IP cap with oldest-first eviction: a reconnect storm from one
    // peer (each EventSource retry opens a new socket while the old one
    // lingers) must not deny live-updates to everyone else.
    const sameIp = [...this.subs].filter((sub) => sub.ip === ip)
    if (sameIp.length >= MAX_EVENT_SUBSCRIBERS_PER_IP) {
      const oldest = sameIp[0]
      if (oldest) {
        this.subs.delete(oldest)
        try {
          oldest.response.end()
        } catch {
          // Already gone; the set removal is what matters.
        }
      }
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.flushHeaders()
    const subscriber: EventSubscriber = { response, ip, auth }
    this.subs.add(subscriber)
    request.on('close', () => {
      this.subs.delete(subscriber)
    })
  }

  /** Ends and forgets every subscriber matching a predicate (revocation). */
  dropSubscribers(predicate: (sub: EventSubscriber) => boolean): void {
    for (const sub of [...this.subs]) {
      if (!predicate(sub)) continue
      this.subs.delete(sub)
      try {
        sub.response.end()
      } catch {
        // Already gone; the set removal is what matters.
      }
    }
  }

  /** True while the credential behind a subscription still authorizes. */
  subscriberAlive(sub: EventSubscriber, now: number = Date.now()): boolean {
    if (sub.auth.kind === 'master') {
      const token = this.deps.getMasterToken()
      return token !== undefined && secretsEqual(sub.auth.token, token)
    }
    if (sub.auth.kind === 'session') {
      const session = this.deps.credentials.sessions.get(sub.auth.id)
      if (!session || !sessionAlive(session, now)) {
        if (session) {
          this.deps.credentials.sessions.delete(sub.auth.id)
          this.deps.credentials.markSessionsDirty()
        }
        return false
      }
      return true
    }
    return takeLiveDevice(this.deps.credentials, sub.auth.token, now) !== null
  }

  /**
   * Starts the keepalive: NATs silently drop idle sockets the client cannot
   * see. Each tick also re-authenticates subscribers, so expiry and
   * revoke take effect on open channels. Dead peers surface on the
   * next failed write and are pruned.
   */
  startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = setInterval(() => {
      for (const sub of [...this.subs]) {
        if (!this.subscriberAlive(sub)) {
          this.dropSubscribers((dead) => dead === sub)
          continue
        }
        try {
          sub.response.write(': ping\n\n')
        } catch {
          this.subs.delete(sub)
        }
      }
    }, EVENT_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  /** Stops the heartbeat and ends every subscription (shutdown). */
  closeAll(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
    for (const sub of this.subs) {
      try {
        sub.response.end()
      } catch {
        // A dead subscriber must never block shutdown.
      }
    }
    this.subs.clear()
  }

  pushLibraryChanged(): void {
    if (this.subs.size === 0) return
    const payload = `data: ${JSON.stringify(this.deps.summarize())}\n\n`
    for (const sub of [...this.subs]) {
      try {
        sub.response.write(payload)
      } catch {
        this.subs.delete(sub)
      }
    }
  }
}
