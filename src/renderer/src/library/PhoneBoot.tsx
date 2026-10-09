import { useState } from 'react'
import { HttpBackend, exchangePairingCode } from '../http-backend'

/**
 * Whether the entered address is plain HTTP (no certificate exists to
 * verify) or HTTPS without a pinned fingerprint (an old or hand-typed link).
 */
function unverifiedWarning(baseUrl: string): string {
  let secure = false
  try {
    secure = new URL(baseUrl.trim()).protocol === 'https:'
  } catch {
    // Unparseable stays on the alarming side: treat as unencrypted.
  }
  return secure
    ? 'This link carries no certificate fingerprint — open desktop Settings and compare it manually before continuing.'
    : 'This connection is unencrypted (no certificate) — anyone on this network could read it. Continue only on a network you trust.'
}

export interface PhoneBootProps {
  readonly initialBaseUrl: string
  readonly initialToken: string | null
  /** Single-use pairing code from a desktop QR/link; null for manual entry. */
  readonly initialPairingCode: string | null
  /**
   * Expected certificate fingerprint from the boot link; null for old links.
   * The phone cannot read TLS details itself, so this is shown for manual
   * comparison against desktop Settings before connecting.
   */
  readonly initialFingerprint: string | null
  /** Why the boot screen returned (e.g. after a logout); shown once. */
  readonly notice: string | null
  onConnect(baseUrl: string, token: string, fingerprint: string | null): void
}

/**
 * Fingerprint trust gate: shown when a boot link carries the expected
 * fingerprint. Connecting stays disabled until the user confirms they
 * compared it — the one defense against a first-connect impostor.
 */
function FingerprintCheck({
  fingerprint,
  acknowledged,
  onAcknowledge
}: {
  fingerprint: string
  acknowledged: boolean
  onAcknowledge: (on: boolean) => void
}) {
  return (
    <>
      <p className="content-sub">
        First connect? Compare this fingerprint with the one in Settings on the
        desktop app (or your browser's padlock details) before continuing.
      </p>
      <p className="settings-note token-value">{fingerprint}</p>
      <label className="boot-label">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />{' '}
        This matches — I trust this server
      </label>
    </>
  )
}

/**
 * First-run gate for the phone client. Two doors: a pairing code from the
 * desktop QR (preferred — the phone gets its own device token and the master
 * token never leaves the desktop) or a manually entered token for old links.
 */
export function PhoneBoot({ initialBaseUrl, initialToken, initialPairingCode, initialFingerprint, notice, onConnect }: PhoneBootProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [token, setToken] = useState(initialToken ?? '')
  const [pairingCode] = useState(initialPairingCode ?? '')
  const [fingerprint] = useState(initialFingerprint)
  const [acknowledged, setAcknowledged] = useState(false)
  // Separate gate for fingerprint-less links: acknowledging an unverified
  // connection is a different decision than confirming a match.
  const [unverifiedAck, setUnverifiedAck] = useState(false)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const trimmedBase = baseUrl.trim()
      const trimmedToken = token.trim()
      // The probe verifies identity before transmitting the token; the
      // adopted fingerprint flows to onConnect so saved trust is bound.
      const probe = new HttpBackend(trimmedBase, trimmedToken, window.localStorage, fingerprint)
      await probe.getLibrary()
      onConnect(trimmedBase, trimmedToken, probe.serverFingerprint)
    } catch {
      setError('Could not reach the server — check the address and token.')
    } finally {
      setBusy(false)
    }
  }

  const pair = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const trimmedBase = baseUrl.trim()
      const deviceToken = await exchangePairingCode(trimmedBase, pairingCode, deviceName, fingerprint)
      const probe = new HttpBackend(trimmedBase, deviceToken, window.localStorage, fingerprint)
      await probe.getLibrary()
      onConnect(trimmedBase, deviceToken, probe.serverFingerprint)
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : 'Pairing failed.')
    } finally {
      setBusy(false)
    }
  }

  if (pairingCode !== '') {
    return (
      <div className="boot">
        <div className="boot-card">
          <h1>Onda</h1>
          <p className="content-sub">Pair this phone with your library.</p>
          {notice !== null && (
            <p className="modal-error" role="status">
              {notice}
            </p>
          )}
          <label className="boot-label" htmlFor="boot-name">
            Device name
          </label>
          <input
            id="boot-name"
            className="search boot-input"
            type="text"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder="e.g. Marco's phone"
            autoComplete="off"
            maxLength={64}
          />
          {fingerprint !== null ? (
            <FingerprintCheck
              fingerprint={fingerprint}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
            />
          ) : (
            <>
              <p className="content-sub">{unverifiedWarning(baseUrl)}</p>
              <label className="boot-label">
                <input
                  type="checkbox"
                  checked={unverifiedAck}
                  onChange={(event) => setUnverifiedAck(event.target.checked)}
                />{' '}
                I understand this connection is unverified
              </label>
            </>
          )}
          {error !== null && (
            <p className="modal-error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="primary-button boot-connect"
            disabled={
              busy ||
              deviceName.trim() === '' ||
              (fingerprint !== null ? !acknowledged : !unverifiedAck)
            }
            onClick={() => void pair()}
          >
            {busy ? 'Pairing…' : 'Pair this device'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="boot">
      <div className="boot-card">
        <h1>Onda</h1>
        <p className="content-sub">Connect to your library at home.</p>
        {notice !== null && (
          <p className="modal-error" role="status">
            {notice}
          </p>
        )}
        <label className="boot-label" htmlFor="boot-url">
          Server address
        </label>
        <input
          id="boot-url"
          className="search boot-input"
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.5:4280"
          autoComplete="off"
        />
        <label className="boot-label" htmlFor="boot-token">
          Access token
        </label>
        <input
          id="boot-token"
          className="search boot-input"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="From Settings on the desktop app"
          autoComplete="off"
        />
        {fingerprint !== null ? (
          <FingerprintCheck
            fingerprint={fingerprint}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
          />
        ) : (
          <>
            <p className="content-sub">{unverifiedWarning(baseUrl)}</p>
            <label className="boot-label">
              <input
                type="checkbox"
                checked={unverifiedAck}
                onChange={(event) => setUnverifiedAck(event.target.checked)}
              />{' '}
              I understand this connection is unverified
            </label>
          </>
        )}
        {error !== null && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary-button boot-connect"
          disabled={
            busy ||
            baseUrl.trim() === '' ||
            token.trim() === '' ||
            (fingerprint !== null ? !acknowledged : !unverifiedAck)
          }
          onClick={() => void connect()}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
