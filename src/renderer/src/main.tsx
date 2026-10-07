import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import type { Backend } from './backend'
import { HttpBackend, loadServerCredentials, saveServerCredentials, tokenFromHash } from './http-backend'
import { CoverStore } from './library/covers'
import { CoverStoreContext } from './library/coverStore'
import { PhoneBoot } from './library/PhoneBoot'
import { usePlaybackEngine } from './usePlaybackEngine'
import { useStreamEngine } from './useStreamEngine'
import './index.css'

function DesktopRoot({ backend }: { backend: Backend }) {
  const playback = usePlaybackEngine((path) => backend.readFile(path))
  const covers = useMemo(() => new CoverStore((path) => backend.readCover(path)), [backend])
  return (
    <CoverStoreContext.Provider value={covers}>
      <App backend={backend} playback={playback} phone={false} />
    </CoverStoreContext.Provider>
  )
}

function PhoneRoot({ backend }: { backend: HttpBackend }) {
  const playback = useStreamEngine(backend)
  const covers = useMemo(() => new CoverStore((path) => backend.readCover(path)), [backend])
  return (
    <CoverStoreContext.Provider value={covers}>
      <App backend={backend} playback={playback} phone />
    </CoverStoreContext.Provider>
  )
}

/**
 * Same bundle boots two apps: under Electron the preload bridge is present and
 * the desktop app owns playback of local files; in a plain browser the phone
 * boot screen connects to the LAN server and streams instead.
 */
function Root() {
  const [phoneBackend, setPhoneBackend] = useState<HttpBackend | null>(() => {
    if (typeof window !== 'undefined' && window.equalizer) return null
    const saved = loadServerCredentials(window.localStorage)
    return saved ? new HttpBackend(saved.baseUrl, saved.token, window.localStorage) : null
  })

  if (typeof window !== 'undefined' && window.equalizer) {
    return <DesktopRoot backend={window.equalizer} />
  }
  if (!phoneBackend) {
    return (
      <PhoneBoot
        initialBaseUrl={window.location.origin}
        initialToken={tokenFromHash(window.location.hash)}
        onConnect={(baseUrl, token) => {
          saveServerCredentials(window.localStorage, { baseUrl, token })
          setPhoneBackend(new HttpBackend(baseUrl, token, window.localStorage))
        }}
      />
    )
  }
  return <PhoneRoot backend={phoneBackend} />
}

const container = document.getElementById('root')
if (!container) throw new Error('missing #root element')

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
