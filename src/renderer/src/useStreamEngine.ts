import { useCallback, useEffect, useRef, useState } from 'react'
import type { EqSettings, Track } from '@shared/types'
import type { EngineStatus, RepeatMode } from './audio/engine'
import { createWebAudioGraph } from './audio/web-audio-graph'
import { StreamEngine } from './audio/stream-engine'
import type { HttpBackend } from './http-backend'
import { IDLE_STATUS, type PlaybackControls } from './usePlaybackEngine'

/**
 * Phone counterpart to usePlaybackEngine: identical controls shape, but the
 * transport streams from the LAN server through an audio element instead of
 * decoding local files. The EQ chain is shared, so curve, presets, and phone-local
 * persistence all behave the same.
 */
export function useStreamEngine(backend: HttpBackend): PlaybackControls {
  const engineRef = useRef<StreamEngine | null>(null)
  const backendRef = useRef(backend)
  backendRef.current = backend
  const [status, setStatus] = useState<EngineStatus>(IDLE_STATUS)
  const [positionSec, setPositionSec] = useState(0)

  useEffect(() => {
    const engine = new StreamEngine({
      createGraph: createWebAudioGraph,
      createAudio: () => new Audio(),
      streamUrl: (path) => backendRef.current.streamUrl(path)
    })
    engineRef.current = engine
    const unsubscribe = engine.subscribe(setStatus)

    return () => {
      unsubscribe()
      engineRef.current = null
      void engine.dispose()
    }
  }, [])

  // Same clock contract as the desktop hook: sample per frame while playing,
  // re-sync on every engine emit otherwise.
  useEffect(() => {
    if (status.state !== 'playing') {
      setPositionSec(engineRef.current?.position() ?? 0)
      return
    }
    let frame = 0
    const tick = (): void => {
      setPositionSec(engineRef.current?.position() ?? 0)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [status])

  const call = useCallback((action: (engine: StreamEngine) => void) => {
    const engine = engineRef.current
    if (engine) action(engine)
  }, [])

  return {
    status,
    positionSec,
    engine: engineRef.current,
    toggle: useCallback(() => call((engine) => void engine.toggle()), [call]),
    next: useCallback(() => call((engine) => void engine.next()), [call]),
    previous: useCallback(() => call((engine) => void engine.previous()), [call]),
    seek: useCallback(
      (position: number) => call((engine) => void engine.seek(position)),
      [call]
    ),
    playAt: useCallback((index: number) => call((engine) => void engine.playAt(index)), [call]),
    playQueue: useCallback(
      (tracks: readonly Track[], startIndex = 0) =>
        call((engine) => {
          engine.setQueue(tracks, startIndex, false)
          void engine.playAt(startIndex)
        }),
      [call]
    ),
    addNext: useCallback(
      (tracks: readonly Track[]) => call((engine) => engine.addNext(tracks)),
      [call]
    ),
    addLast: useCallback(
      (tracks: readonly Track[]) => call((engine) => engine.addLast(tracks)),
      [call]
    ),
    removeAt: useCallback(
      (index: number) => call((engine) => engine.removeAt(index)),
      [call]
    ),
    refreshTracks: useCallback(
      (tracks: readonly Track[]) => call((engine) => engine.refreshTracks(tracks)),
      [call]
    ),
    setEq: useCallback(
      (settings: EqSettings) => call((engine) => engine.setEq(settings)),
      [call]
    ),
    setRepeat: useCallback(
      (mode: RepeatMode) => call((engine) => engine.setRepeat(mode)),
      [call]
    ),
    cycleRepeat: useCallback(() => call((engine) => engine.cycleRepeat()), [call]),
    setShuffle: useCallback(
      (on: boolean) => call((engine) => engine.setShuffle(on)),
      [call]
    ),
    toggleShuffle: useCallback(() => call((engine) => engine.toggleShuffle()), [call]),
    setVolume: useCallback((volume: number) => call((engine) => engine.setVolume(volume)), [call])
  }
}
