import { useRef } from 'react'
import { createWebAudioGraph } from './audio/web-audio-graph'
import { StreamEngine } from './audio/stream-engine'
import type { HttpBackend } from './http-backend'
import { useEngineControls, type PlaybackControls } from './usePlaybackEngine'

/**
 * Phone counterpart to usePlaybackEngine: identical controls shape, but the
 * transport streams from the LAN server through an audio element instead of
 * decoding local files. The EQ chain is shared, so curve, presets, and phone-local
 * persistence all behave the same.
 */
export function useStreamEngine(backend: HttpBackend): PlaybackControls {
  const backendRef = useRef(backend)
  backendRef.current = backend
  return useEngineControls(
    () =>
      new StreamEngine({
        createGraph: createWebAudioGraph,
        createAudio: () => new Audio(),
        streamUrl: (path) => backendRef.current.streamUrl(path),
        // The element reports no status: a 401 looks like any other failure,
        // so re-probe auth and let a dead credential route to boot.
        onMediaError: () => backendRef.current.probeAuthAfterFailure()
      })
  )
}
