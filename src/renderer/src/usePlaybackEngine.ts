import { useCallback, useEffect, useRef, useState } from 'react'
import type { EqSettings, Track } from '@shared/types'
import { PlaybackEngine, type EngineStatus, type RepeatMode } from './audio/engine'
import type { StreamEngine } from './audio/stream-engine'
import { createWebAudioGraph } from './audio/web-audio-graph'
import { defaultEqSettings } from './audio/settings'

export const IDLE_STATUS: EngineStatus = {
  state: 'idle',
  track: null,
  index: -1,
  queue: [],
  queueLength: 0,
  eq: defaultEqSettings(),
  repeat: 'off',
  shuffle: false,
  positionSec: 0,
  durationSec: 0,
  volume: 0.85,
  error: null
}

export interface PlaybackControls {
  readonly status: EngineStatus
  readonly positionSec: number
  readonly engine: PlaybackEngine | StreamEngine | null
  toggle(): void
  next(): void
  previous(): void
  seek(positionSec: number): void
  playAt(index: number): void
  playQueue(tracks: readonly Track[], startIndex?: number): void
  addNext(tracks: readonly Track[]): void
  addLast(tracks: readonly Track[]): void
  removeAt(index: number): void
  refreshTracks(tracks: readonly Track[]): void
  setEq(settings: EqSettings): void
  setRepeat(mode: RepeatMode): void
  cycleRepeat(): void
  setShuffle(on: boolean): void
  toggleShuffle(): void
  setVolume(volume: number): void
}

/**
 * The control surface the hook shell needs. Both engines satisfy it today;
 * if one drifts, the compiler points at the divergence instead of users.
 */
export interface EngineControlsTarget {
  subscribe(listener: (status: EngineStatus) => void): () => void
  position(): number
  dispose(): Promise<void>
  toggle(): Promise<void>
  seek(positionSec: number): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  playAt(index: number): Promise<void>
  setQueue(tracks: readonly Track[], startIndex?: number, preservePlayback?: boolean): void
  addNext(tracks: readonly Track[]): void
  addLast(tracks: readonly Track[]): void
  removeAt(index: number): void
  refreshTracks(tracks: readonly Track[]): void
  setEq(settings: EqSettings): void
  setRepeat(mode: RepeatMode): void
  cycleRepeat(): void
  setShuffle(on: boolean): void
  toggleShuffle(): void
  setVolume(linear: number): void
}

/**
 * Shared shell behind usePlaybackEngine/useStreamEngine: engine lifetime,
 * status subscription, per-frame position clock, and the control table.
 * Only engine construction differs per transport. The constructor rides a
 * ref (same idiom as the old readFileRef/backendRef mirrors) so the engine
 * is still created exactly once on mount.
 */
export function useEngineControls<E extends EngineControlsTarget>(
  create: () => E
): Omit<PlaybackControls, 'engine'> & { engine: E | null } {
  const engineRef = useRef<E | null>(null)
  const createRef = useRef(create)
  createRef.current = create
  const [status, setStatus] = useState<EngineStatus>(IDLE_STATUS)
  const [positionSec, setPositionSec] = useState(0)

  useEffect(() => {
    const engine = createRef.current()
    engineRef.current = engine
    const unsubscribe = engine.subscribe(setStatus)

    return () => {
      unsubscribe()
      engineRef.current = null
      void engine.dispose()
    }
  }, [])

  // The engine only reports on transitions, so the clock is sampled per frame
  // while playing. The snapshot branch re-runs on every engine emit — not just
  // state flips — so seeks made while paused visibly move the slider at once.
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

  const call = useCallback((action: (engine: E) => void) => {
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

/**
 * Owns the engine for the lifetime of the component. The graph is created lazily
 * inside the engine, so no AudioContext exists until the first play.
 *
 * The queue is explicit: viewing/navigating never touches it. Only play actions
 * (playQueue/playAt) change what is queued, so drilling into an album cannot
 * interrupt playback.
 *
 * Audio bytes come from the injected reader (Electron bridge by default), so a
 * streaming backend can supply them instead without touching this hook.
 */
export function usePlaybackEngine(
  readFile: (path: string) => Promise<ArrayBuffer> = (path) => window.equalizer.readFile(path)
): PlaybackControls {
  const readFileRef = useRef(readFile)
  readFileRef.current = readFile
  return useEngineControls(
    () =>
      new PlaybackEngine({
        createGraph: createWebAudioGraph,
        readFile: (path) => readFileRef.current(path)
      })
  )
}
