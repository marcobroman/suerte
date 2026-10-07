import { useState } from 'react'
import { HttpBackend } from '../http-backend'

export interface PhoneBootProps {
  readonly initialBaseUrl: string
  readonly initialToken: string | null
  onConnect(baseUrl: string, token: string): void
}

/** First-run gate for the phone client: server address + access token, verified before entering. */
export function PhoneBoot({ initialBaseUrl, initialToken, onConnect }: PhoneBootProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl)
  const [token, setToken] = useState(initialToken ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const trimmedBase = baseUrl.trim()
      const trimmedToken = token.trim()
      const probe = new HttpBackend(trimmedBase, trimmedToken, window.localStorage)
      await probe.getLibrary()
      onConnect(trimmedBase, trimmedToken)
    } catch {
      setError('Could not reach the server — check the address and token.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="boot">
      <div className="boot-card">
        <h1>Onda</h1>
        <p className="content-sub">Connect to your library at home.</p>
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
        {error !== null && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          className="primary-button boot-connect"
          disabled={busy || baseUrl.trim() === '' || token.trim() === ''}
          onClick={() => void connect()}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </div>
  )
}
