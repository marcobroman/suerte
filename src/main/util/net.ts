import { networkInterfaces } from 'node:os'

/**
 * Non-loopback IPv4 addresses of this machine — the home LAN address plus
 * the tailnet address when Tailscale runs. Shared by certificate SANs and
 * displayed LAN URLs so the two can never disagree on the filter.
 */
export function listIPv4Addresses(): string[] {
  const found: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && !found.includes(address.address)) {
        found.push(address.address)
      }
    }
  }
  return found
}
