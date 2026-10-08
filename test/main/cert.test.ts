import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureServerCert } from '@main/cert'

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
})
