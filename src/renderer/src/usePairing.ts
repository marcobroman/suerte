import { useCallback, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { Backend } from './backend'
import { phonePairUrl } from './http-backend'
import type { ServerAdmin, ServerAdminQr } from './useServerAdmin'

/**
 * Lazy access to the server-admin hook. The two hooks need each other —
 * admin actions clear the QR display, pairing jobs drive busy/message state
 * — so App constructs pairing first and hands it a getter resolved from a
 * ref. The getter only ever runs inside click handlers and serialized jobs
 * (always post-render), never during render, so it is always populated.
 */
export type GetServerAdmin = () => ServerAdmin

/** QR image size; scanned once by the phone camera, so small is fine. */
const QR_CODE_WIDTH = 200
const QR_CODE_MARGIN = 1

export interface Pairing {
  readonly qrDataUrl: string | null
  readonly qrCode: string | null
  readonly qrBase: string | null
  readonly qrExpiry: number | null
  /** Stable QR-clearing callbacks for the admin hook (toggle clears the image only, regenerate clears all). */
  readonly qr: ServerAdminQr
  hideQrCode(): void
  showQrCode(base: string): void
  renewQrCode(): void
  copyPairLink(base: string): void
  restartServer(): void
  regenerateServerCert(): void
}

/**
 * Phone-pairing ownership: QR/link codes, the burn-before-mint mutex, and
 * every action whose ordering guards a live code. Busy/message/fingerprint
 * ride the admin hook via the getter; nothing here reads admin state during
 * render.
 */
export function usePairing(backend: Backend, getAdmin: GetServerAdmin): Pairing {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  /** The pairing code behind the displayed QR, if any — burned on discard. */
  const [qrCode, setQrCode] = useState<string | null>(null)
  /** The server address the displayed QR pairs over, if any. */
  const [qrBase, setQrBase] = useState<string | null>(null)
  /** Expiry epoch ms of the displayed code, for the "valid until" caption. */
  const [qrExpiry, setQrExpiry] = useState<number | null>(null)
  /**
   * The pairing code behind the displayed QR. A ref, not just state: jobs
   * below serialize through a chain, and only the ref is current when a
   * queued job finally runs — rapid clicks can no longer mint two codes.
   * Split of duties: `qrCode/qrBase/qrExpiry` state is display-only; this
   * ref (and `liveLinkCodesByBase`) is the burn authority on discard.
   */
  const liveQrCode = useRef<string | null>(null)
  /** Serializes pairing jobs so burns always precede the mint they guard. */
  const pairMutex = useRef<Promise<void>>(Promise.resolve())
  /**
   * Outstanding copy-link codes per base URL. Copying burns the previous
   * link code for that base, so at most one link code is ever live — the
   * same single-code discipline the QR display already keeps.
   */
  const liveLinkCodesByBase = useRef(new Map<string, string>())

  const serializePairing = useCallback((job: () => Promise<void>): void => {
    pairMutex.current = pairMutex.current.then(job, job)
  }, [])

  /** Burns one code, never throwing: the 10-minute expiry is the backstop. */
  const burnCode = useCallback(
    async (code: string): Promise<void> => {
      try {
        await backend.burnPairingCode(code)
      } catch {
        // Best effort, as above.
      }
    },
    [backend]
  )

  const clearQrDisplay = useCallback(() => {
    setQrDataUrl(null)
    setQrCode(null)
    setQrBase(null)
    setQrExpiry(null)
  }, [])

  const clearQrDataUrl = useCallback(() => {
    setQrDataUrl(null)
  }, [])

  // Stable identity so the admin hook's action callbacks stay memoized.
  const qr = useMemo(
    () => ({ clearQrDataUrl, clearQrDisplay }),
    [clearQrDataUrl, clearQrDisplay]
  )

  const restartServer = useCallback(() => {
    const admin = getAdmin()
    admin.setServerBusy(true)
    admin.setServerMessage('')
    // Restarting keeps the in-memory pairing book, so burn the displayed
    // code instead of orphaning it.
    const shown = liveQrCode.current
    liveQrCode.current = null
    clearQrDisplay()
    serializePairing(async () => {
      if (shown !== null) await burnCode(shown)
      try {
        const settings = await backend.restartServer()
        admin.refreshServerState(settings)
        if (settings.server.url !== null) {
          admin.setServerMessage('Serving again — phones confirm the fingerprint if it changed.')
        } else {
          admin.setServerMessage('Could not restart — the port may be taken.')
        }
      } catch {
        admin.setServerMessage('Could not restart the server.')
      } finally {
        admin.setServerBusy(false)
      }
    })
  }, [backend, burnCode, clearQrDisplay, getAdmin, serializePairing])

  const regenerateServerCert = useCallback(() => {
    const admin = getAdmin()
    admin.setServerBusy(true)
    // A new identity does not wipe pairing codes, so burn the displayed one
    // instead of orphaning it.
    const shown = liveQrCode.current
    liveQrCode.current = null
    clearQrDisplay()
    serializePairing(async () => {
      if (shown !== null) await burnCode(shown)
      try {
        const settings = await backend.regenerateServerCert()
        admin.refreshServerState(settings)
        admin.setServerMessage('New certificate — phones confirm the new fingerprint once.')
      } catch {
        admin.setServerMessage('Could not regenerate the certificate.')
      } finally {
        admin.setServerBusy(false)
      }
    })
  }, [backend, burnCode, clearQrDisplay, getAdmin, serializePairing])

  const hideQrCode = useCallback((): void => {
    const shown = liveQrCode.current
    liveQrCode.current = null
    clearQrDisplay()
    if (shown !== null) serializePairing(() => burnCode(shown))
  }, [burnCode, clearQrDisplay, serializePairing])

  const showQrCode = useCallback(
    (base: string): void => {
      serializePairing(async () => {
        const admin = getAdmin()
        // Earlier jobs finished (chain), so the ref is current: burn
        // whatever is live for this address before minting.
        const prior = liveQrCode.current
        if (prior !== null) {
          liveQrCode.current = null
          await burnCode(prior)
        }
        const liveLink = liveLinkCodesByBase.current.get(base)
        if (liveLink !== undefined) {
          liveLinkCodesByBase.current.delete(base)
          await burnCode(liveLink)
        }
        admin.setServerBusy(true)
        try {
          // Pairing entry, not API: the boot screen reads the single-use code
          // from the fragment, which browsers never send to the server — and
          // the master token never leaves this machine.
          const pairing = await backend.getPairingCode()
          if (!pairing) {
            admin.setServerMessage('Could not create a pairing code.')
            clearQrDisplay()
            return
          }
          liveQrCode.current = pairing.code
          setQrCode(pairing.code)
          setQrBase(base)
          setQrExpiry(pairing.expiresAt)
          setQrDataUrl(
            await QRCode.toDataURL(phonePairUrl(base, pairing.code, admin.serverState.fingerprint), {
              width: QR_CODE_WIDTH,
              margin: QR_CODE_MARGIN
            })
          )
        } catch {
          admin.setServerMessage('Could not generate the QR code.')
          clearQrDisplay()
        } finally {
          admin.setServerBusy(false)
        }
      })
    },
    [backend, burnCode, clearQrDisplay, getAdmin, serializePairing]
  )

  const renewQrCode = useCallback(() => {
    if (qrBase !== null) showQrCode(qrBase)
  }, [qrBase, showQrCode])

  const copyPairLink = useCallback(
    (base: string): void => {
      serializePairing(async () => {
        const admin = getAdmin()
        const previous = liveLinkCodesByBase.current.get(base)
        if (previous !== undefined) {
          liveLinkCodesByBase.current.delete(base)
          await burnCode(previous)
        }
        admin.setServerBusy(true)
        try {
          const pairing = await backend.getPairingCode()
          if (!pairing) {
            admin.setServerMessage('Could not create a pairing code.')
            return
          }
          liveLinkCodesByBase.current.set(base, pairing.code)
          await navigator.clipboard.writeText(phonePairUrl(base, pairing.code, admin.serverState.fingerprint))
          admin.setServerMessage('Copied — open it on the phone within 10 minutes.')
        } catch {
          admin.setServerMessage('Copy failed — generate a QR code instead.')
        } finally {
          admin.setServerBusy(false)
        }
      })
    },
    [backend, burnCode, getAdmin, serializePairing]
  )

  return {
    qrDataUrl,
    qrCode,
    qrBase,
    qrExpiry,
    qr,
    hideQrCode,
    showQrCode,
    renewQrCode,
    copyPairLink,
    restartServer,
    regenerateServerCert
  }
}
