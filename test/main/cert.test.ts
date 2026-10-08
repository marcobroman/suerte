import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import selfsigned from 'selfsigned'
import { ensureServerCert, certCoversIps, certIpSans, localIPv4s } from '@main/cert'

describe('ensureServerCert', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'onda-cert-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('generates and persists an identity on first use', async () => {
    const cert = await ensureServerCert(dir)

    expect(cert.cert).toContain('CERTIFICATE')
    expect(cert.key).toContain('PRIVATE KEY')
    expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(cert.expiresAt).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000)
    expect(await readFile(join(dir, 'server-cert.pem'), 'utf8')).toContain('CERTIFICATE')
    expect(await readFile(join(dir, 'server-key.pem'), 'utf8')).toContain('PRIVATE KEY')
  })

  it('reuses the stored identity instead of regenerating', async () => {
    const first = await ensureServerCert(dir)
    const second = await ensureServerCert(dir)

    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.cert).toBe(first.cert)
  })

  it('mints a fresh identity on regenerate', async () => {
    const first = await ensureServerCert(dir)
    const second = await ensureServerCert(dir, true)

    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect((await ensureServerCert(dir)).fingerprint).toBe(second.fingerprint)
  })

  it('recovers from corrupt files instead of crashing', async () => {
    await writeFile(join(dir, 'server-cert.pem'), 'not a certificate', 'utf8')
    await writeFile(join(dir, 'server-key.pem'), 'not a key', 'utf8')

    const cert = await ensureServerCert(dir)

    expect(cert.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })

  it('names localhost, loopback, and every local address in the SAN', async () => {
    const cert = await ensureServerCert(dir)
    const sans = certIpSans(cert.cert)

    expect(sans).toEqual(expect.arrayContaining(['127.0.0.1', ...localIPv4s()]))
    expect(certCoversIps(cert.cert, localIPv4s())).toBe(true)
  })

  it('detects uncovered addresses and unparseable input', async () => {
    const cert = await ensureServerCert(dir)

    expect(certCoversIps(cert.cert, [...localIPv4s(), '203.0.113.99'])).toBe(false)
    expect(certCoversIps('not a certificate', ['127.0.0.1'])).toBe(false)
    expect(certIpSans('not a certificate')).toBeNull()
  })

  it('renews a stored identity that no longer covers this machine', async () => {
    if (localIPv4s().length === 0) return
    const stale = await selfsigned.generate([{ name: 'commonName', value: 'Onda Server' }], {
      keySize: 2048,
      algorithm: 'sha256'
    })
    await writeFile(join(dir, 'server-cert.pem'), stale.cert, 'utf8')
    await writeFile(join(dir, 'server-key.pem'), stale.private, 'utf8')

    const renewed = await ensureServerCert(dir)

    expect(renewed.fingerprint).not.toBe(new X509Certificate(stale.cert).fingerprint256)
    expect(certCoversIps(renewed.cert, localIPv4s())).toBe(true)
  })
})
