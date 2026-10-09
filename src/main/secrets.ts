import { safeStorage } from 'electron'

/**
 * Encrypts the handful of secrets the app persists (server token, session
 * ids, device tokens, Discogs token). Plaintext lives only in memory; the
 * config file holds envelopes shaped `{ enc: <base64> }`, which the shape
 * check in config.ts tells apart from legacy bare strings.
 */
export interface SecretBox {
  /** False when the OS vault is unreachable (locked keyring, headless, …). */
  available(): boolean
  /** Encrypts; returns an envelope, or the input unchanged for passthrough. */
  protect(plaintext: string): string | { enc: string }
  /** Decrypts envelopes and passes bare strings through. Throws on failure. */
  unprotect(value: string | { enc: string }): string
}

/** Production box: DPAPI on Windows, Keychain on macOS, libsecret on Linux. */
export function electronSecretBox(): SecretBox {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    protect: (plaintext) => ({ enc: safeStorage.encryptString(plaintext).toString('base64') }),
    unprotect: (value) => {
      if (typeof value === 'string') return value
      return safeStorage.decryptString(Buffer.from(value.enc, 'base64'))
    }
  }
}

/**
 * Plaintext box for tests and for contexts with no vault. Protect is the
 * identity, so files stay human-readable; envelopes from a real box are
 * unreadable here and fail closed (thrown, caught by normalizers → dropped).
 */
export function plaintextSecretBox(): SecretBox {
  return {
    available: () => true,
    protect: (plaintext) => plaintext,
    unprotect: (value) => {
      if (typeof value === 'string') return value
      throw new Error('no vault available to open this envelope')
    }
  }
}

/** True for `{ enc: <non-empty base64-ish string> }` and nothing else. */
export function isEncryptedEnvelope(value: unknown): value is { enc: string } {
  if (typeof value !== 'object' || value === null) return false
  const enc = (value as Record<string, unknown>)['enc']
  return typeof enc === 'string' && enc !== ''
}
