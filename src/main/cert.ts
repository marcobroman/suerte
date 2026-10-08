import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import selfsigned from 'selfsigned'

const CERT_FILE = 'server-cert.pem'
const KEY_FILE = 'server-key.pem'

/** The server's TLS identity: a self-signed certificate trusted once per phone via its fingerprint. */
export interface ServerCert {
  readonly cert: string
  readonly key: string
  /** SHA-256 fingerprint as colon-separated hex, shown in Settings for trust-on-first-use. */
  readonly fingerprint: string
  readonly expiresAt: number
}

function certPath(directory: string): string {
  return join(directory, CERT_FILE)
}

function keyPath(directory: string): string {
  return join(directory, KEY_FILE)
}

function describe(pem: string): { fingerprint: string; expiresAt: number } {
  const certificate = new X509Certificate(pem)
  const expiresAt = Date.parse(certificate.validTo)
  if (!Number.isFinite(expiresAt)) throw new Error('certificate has no expiry')
  return { fingerprint: certificate.fingerprint256, expiresAt }
}

/**
 * Loads the server certificate, generating and persisting one on first use
 * (or when `regenerate` is set, or the stored files are unreadable/corrupt).
 * The key file gets owner-only permissions where the platform supports it;
 * on Windows the ACL step is a best-effort no-op that never fails the call.
 */
export async function ensureServerCert(directory: string, regenerate = false): Promise<ServerCert> {
  if (!regenerate) {
    try {
      const [cert, key] = await Promise.all([
        readFile(certPath(directory), 'utf8'),
        readFile(keyPath(directory), 'utf8')
      ])
      // Parsing validates: a half-written or hand-edited file falls through
      // to generation instead of crashing the server at listen time.
      const info = describe(cert)
      // An unreadable key is equally fatal, so require a plausible PEM body.
      if (!key.includes('PRIVATE KEY')) throw new Error('unusable key file')
      return { cert, key, fingerprint: info.fingerprint, expiresAt: info.expiresAt }
    } catch {
      // Missing or corrupt: fall through and mint a fresh identity below.
    }
  }
  let generated: { cert: string; private: string }
  try {
    const now = new Date()
    generated = await selfsigned.generate([{ name: 'commonName', value: 'Onda Server' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notBeforeDate: now,
      notAfterDate: new Date(now.getTime() + 825 * 24 * 60 * 60 * 1000),
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' }
          ]
        }
      ]
    })
  } catch (error: unknown) {
    throw new Error('could not generate a server certificate', { cause: error })
  }
  const info = describe(generated.cert)
  await mkdir(directory, { recursive: true })
  // Stored byte-for-byte as generated, so a reload returns the identical
  // strings and never looks like a fresh identity.
  await writeFile(keyPath(directory), generated.private, 'utf8')
  await writeFile(certPath(directory), generated.cert, 'utf8')
  try {
    await chmod(keyPath(directory), 0o600)
  } catch {
    // Windows has no POSIX modes; the user-data dir is already user-private.
  }
  return { cert: generated.cert, key: generated.private, fingerprint: info.fingerprint, expiresAt: info.expiresAt }
}
