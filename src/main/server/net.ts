import type { IncomingMessage } from 'node:http'
import { listIPv4Addresses } from '../util/net'

/** First LAN IPv4, for the "open this on your phone" display. Loopback excluded. */
export function lanBaseUrl(port: number, secure = false): string | null {
  return lanBaseUrls(port, secure)[0] ?? null
}

/**
 * Every reachable LAN IPv4 base URL (loopback excluded): typically the home
 * LAN address plus the tailnet address when Tailscale runs. The desktop
 * settings screen lists them all so remote pairing picks the right one.
 */
export function lanBaseUrls(port: number, secure = false): string[] {
  const scheme = secure ? 'https' : 'http'
  const urls: string[] = []
  for (const address of listIPv4Addresses()) {
    const url = `${scheme}://${address}:${port}`
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

export type ServerTransport = 'https' | 'http' | 'disabled'

/**
 * Fail closed: without a certificate the server only listens with explicit
 * user opt-in (`allowInsecure`). Callers gate `start()` on this — the server
 * itself still serves whatever identity it is given.
 */
export function selectServerTransport(
  tls: { cert: string; key: string } | null,
  allowInsecure: boolean
): ServerTransport {
  if (tls) return 'https'
  return allowInsecure ? 'http' : 'disabled'
}

/** Rate-limit (and subscriber) bucket key for a peer. Exported for tests. */
export function bucketIp(request: Pick<IncomingMessage, 'socket'>): string {
  const raw = request.socket.remoteAddress ?? 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw
}
