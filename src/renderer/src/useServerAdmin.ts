import { useCallback, useState } from 'react'
import { DEFAULT_SERVER_PORT, type ServerStatus } from '@shared/types'
import type { Backend } from './backend'

/**
 * QR-display callbacks owned (for now) by the caller: toggling the server
 * clears only the QR image (the code behind it stays burnable on discard),
 * while token regeneration clears the whole display. Split for the same
 * burn discipline the pairing hook enforces.
 */
export interface ServerAdminQr {
  clearQrDataUrl(): void
  clearQrDisplay(): void
}

export interface ServerAdmin {
  readonly serverState: ServerStatus
  readonly serverBusy: boolean
  readonly serverMessage: string
  readonly serverToken: string | null
  readonly portDraft: string
  setPortDraft(draft: string): void
  /** Busy/message control for the pairing-mutex actions in usePairing. */
  setServerBusy(busy: boolean): void
  setServerMessage(message: string): void
  refreshServerState(settings: { server: ServerStatus }): void
  toggleServer(): void
  savePort(): void
  showServerToken(): void
  regenerateServerToken(): void
  toggleInsecure(): void
  revokeDevice(id: string): void
}

/**
 * Desktop server administration: state plus the six mutex-free actions.
 * Pairing-mutex actions (restart, cert, QR) live in usePairing; this hook
 * only borrows its QR-clearing callbacks so display discipline stays whole.
 */
export function useServerAdmin(backend: Backend, qr: ServerAdminQr): ServerAdmin {
  const [serverState, setServerState] = useState<ServerStatus>({
    enabled: false,
    port: DEFAULT_SERVER_PORT,
    tokenSet: false,
    allowInsecure: false,
    secretsLocked: false,
    url: null,
    urls: [],
    secure: false,
    fingerprint: null,
    certExpiresAt: null,
    certStale: false,
    devices: []
  })
  const [serverToken, setServerToken] = useState<string | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [serverBusy, setServerBusy] = useState(false)
  const [serverMessage, setServerMessage] = useState('')

  const refreshServerState = useCallback(
    (settings: { server: ServerStatus }) => {
      setServerState(settings.server)
      if (!settings.server.tokenSet) setServerToken(null)
    },
    []
  )

  /**
   * Shared tail for server-admin actions: busy on, work, ok/err message,
   * busy off. Per-action pre-steps (clearing the token, QR, or message)
   * stay at the call site — they differ per action. Pairing-mutex actions
   * (restart, cert, QR) do not use this; their burn ordering stays inline.
   */
  const runServerAction = useCallback(
    <T,>(work: () => Promise<T>, onOk: (value: T) => void, errMsg: string): void => {
      setServerBusy(true)
      void work().then(onOk, () => setServerMessage(errMsg)).finally(() => setServerBusy(false))
    },
    []
  )

  const toggleServer = useCallback(() => {
    const next = !serverState.enabled
    setServerMessage('')
    setServerToken(null)
    qr.clearQrDataUrl()
    runServerAction(
      () => backend.setServerEnabled(next),
      (settings) => {
        refreshServerState(settings)
        if (next && settings.server.url === null) {
          setServerMessage(
            settings.server.secretsLocked
              ? 'OS keyring unavailable — serving stays off until it unlocks.'
              : 'Could not listen — the port may be taken, or the certificate is missing.'
          )
        }
      },
      'Could not change the server.'
    )
  }, [backend, serverState.enabled, refreshServerState, runServerAction, qr])

  const savePort = useCallback(() => {
    setServerMessage('')
    runServerAction(
      () => backend.setServerPort(Number(portDraft)),
      (settings) => {
        refreshServerState(settings)
        setPortDraft('')
      },
      'Could not change the port.'
    )
  }, [backend, portDraft, refreshServerState, runServerAction])

  const showServerToken = useCallback(() => {
    runServerAction(
      () => backend.getServerToken(),
      (token) => setServerToken(token),
      'Could not read the token.'
    )
  }, [backend, runServerAction])

  const regenerateServerToken = useCallback(() => {
    setServerToken(null)
    // Rotation already wipes every pending code server-side; this just
    // clears a now-useless QR from the screen.
    qr.clearQrDisplay()
    runServerAction(
      () => backend.regenerateServerToken(),
      (settings) => {
        refreshServerState(settings)
        setServerMessage('New token generated — every phone is logged out.')
      },
      'Could not regenerate the token.'
    )
  }, [backend, refreshServerState, runServerAction, qr])

  const toggleInsecure = useCallback(() => {
    const next = !serverState.allowInsecure
    setServerMessage('')
    runServerAction(
      () => backend.setServerInsecure(next),
      (settings) => {
        refreshServerState(settings)
        if (!next && settings.server.enabled && settings.server.url === null) {
          setServerMessage('Unencrypted fallback off — the server stopped.')
        }
      },
      'Could not change the fallback.'
    )
  }, [backend, serverState.allowInsecure, refreshServerState, runServerAction])

  const revokeDevice = useCallback(
    (id: string) => {
      runServerAction(
        () => backend.revokeServerDevice(id),
        (settings) => {
          refreshServerState(settings)
          setServerMessage('Device revoked — it is logged out immediately.')
        },
        'Could not revoke the device.'
      )
    },
    [backend, refreshServerState, runServerAction]
  )

  return {
    serverState,
    serverBusy,
    serverMessage,
    serverToken,
    portDraft,
    setPortDraft,
    setServerBusy,
    setServerMessage,
    refreshServerState,
    toggleServer,
    savePort,
    showServerToken,
    regenerateServerToken,
    toggleInsecure,
    revokeDevice
  }
}
