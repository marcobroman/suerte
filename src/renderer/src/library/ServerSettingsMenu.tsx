import { describeServerUrl } from '../http-backend'
import type { ServerAdmin } from '../useServerAdmin'
import type { Pairing } from '../usePairing'

export interface ServerSettingsMenuProps {
  readonly admin: ServerAdmin
  readonly pairing: Pairing
}

/** Phone-streaming section of the settings menu; all behavior rides the two server hooks. */
export function ServerSettingsMenu({ admin, pairing }: ServerSettingsMenuProps) {
  const {
    serverState,
    serverBusy,
    serverMessage,
    serverToken,
    portDraft,
    setPortDraft,
    toggleServer,
    savePort,
    showServerToken,
    regenerateServerToken,
    toggleInsecure,
    revokeDevice
  } = admin
  const {
    qrDataUrl,
    qrBase,
    qrExpiry,
    showQrCode,
    renewQrCode,
    copyPairLink,
    hideQrCode,
    restartServer,
    regenerateServerCert
  } = pairing
  return (
    <>
      <p className="settings-label">Phone streaming</p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={serverState.enabled}
          disabled={serverBusy}
          onChange={toggleServer}
        />{' '}
        Serve library on the local network
      </label>
      {serverState.enabled && (
        <>
          {serverState.url !== null ? (
            serverState.urls.map((reachable) => {
              const kind = describeServerUrl(reachable)
              return (
                <div key={reachable}>
                  <p className="settings-note">{reachable}</p>
                  <p className="settings-note">
                    {kind === 'tailscale'
                      ? 'Tailscale — works from anywhere'
                      : 'Home network — same Wi-Fi only'}
                  </p>
                  <button
                    type="button"
                    role="menuitem"
                    className="settings-item"
                    disabled={serverBusy}
                    onClick={() => void copyPairLink(reachable)}
                  >
                    Copy pairing link (10 minutes)
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="settings-item"
                    disabled={serverBusy}
                    onClick={() => void showQrCode(reachable)}
                  >
                    Show QR code
                  </button>
                </div>
              )
            })
          ) : (
            <p className="settings-note">
              Not reachable — the port may be taken.
            </p>
          )}
          {qrDataUrl !== null && (
            <>
              <img
                className="qr-code"
                src={qrDataUrl}
                alt="QR code linking to the phone client"
              />
              <p className="settings-note">
                Pairs over{' '}
                {qrBase !== null && describeServerUrl(qrBase) === 'tailscale'
                  ? 'Tailscale'
                  : 'the home network'}
                {qrExpiry !== null &&
                  ` — code valid until ${new Date(qrExpiry).toLocaleTimeString()}`}.
                Hiding it kills the code immediately.
              </p>
              <button
                type="button"
                role="menuitem"
                className="settings-item"
                disabled={serverBusy || qrBase === null}
                onClick={() => renewQrCode()}
              >
                New code
              </button>
              <button
                type="button"
                role="menuitem"
                className="settings-item"
                onClick={() => hideQrCode()}
              >
                Hide QR code
              </button>
            </>
          )}
          <div className="token-row">
            <input
              className="token-input"
              inputMode="numeric"
              placeholder={`Port (now ${serverState.port})`}
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              aria-label="Server port"
            />
            <button
              type="button"
              className="token-save"
              disabled={serverBusy || portDraft.trim() === ''}
              onClick={savePort}
            >
              Set
            </button>
          </div>
          {serverToken !== null ? (
            <p className="settings-note token-value">{serverToken}</p>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="settings-item"
              disabled={serverBusy}
              onClick={showServerToken}
            >
              Show access token
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="settings-item"
            disabled={serverBusy}
            onClick={regenerateServerToken}
          >
            New access token
          </button>
          <p className="settings-label">Security</p>
          <p className="settings-note">
            {serverState.secure
              ? 'Encrypted — phones connect over TLS. Confirm this fingerprint on first connect:'
              : serverState.url !== null
                ? 'NOT encrypted — the server runs plain HTTP. Prefer fixing the certificate over keeping this.'
                : 'Not encrypted — the server runs plain HTTP.'}
          </p>
          {serverState.fingerprint !== null && (
            <p className="settings-note token-value">{serverState.fingerprint}</p>
          )}
          {serverState.certExpiresAt !== null && (
            <p className="settings-note">
              Certificate valid until{' '}
              {new Date(serverState.certExpiresAt).toLocaleDateString()}
            </p>
          )}
          {serverState.certStale && (
            <>
              <p className="settings-note">
                Network addresses changed — the certificate no longer names this
                machine. Restart serving to renew it (phones confirm the new
                fingerprint once).
              </p>
              <button
                type="button"
                role="menuitem"
                className="settings-item"
                disabled={serverBusy}
                onClick={restartServer}
              >
                Restart server
              </button>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            className="settings-item"
            disabled={serverBusy}
            onClick={regenerateServerCert}
          >
            New certificate
          </button>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={serverState.allowInsecure}
              disabled={serverBusy}
              onChange={toggleInsecure}
            />{' '}
            Allow unencrypted fallback if the certificate fails
          </label>
          {serverState.secretsLocked && (
            <p className="settings-note" role="alert">
              OS keyring unavailable — the server cannot keep tokens and stays
              stopped. Unlock the keyring (or set one up), then toggle
              serving off and on again.
            </p>
          )}
          <p className="settings-label">Connected devices</p>
          {serverState.devices.length === 0 ? (
            <p className="settings-note">
              No paired devices — scan the QR code to pair one.
            </p>
          ) : (
            serverState.devices.map((device) => (
              <div key={device.id} className="token-row">
                <p className="settings-note">
                  {device.name} · paired{' '}
                  {new Date(device.createdAt).toLocaleDateString()} · seen{' '}
                  {new Date(device.lastSeen).toLocaleString()}
                </p>
                <button
                  type="button"
                  className="token-save"
                  disabled={serverBusy}
                  onClick={() => revokeDevice(device.id)}
                  aria-label={`Revoke ${device.name}`}
                >
                  Revoke
                </button>
              </div>
            ))
          )}
        </>
      )}
      {serverMessage !== '' && <p className="settings-note">{serverMessage}</p>}
    </>
  )
}
