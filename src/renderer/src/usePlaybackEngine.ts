import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EqSettings, Track } from '@shared/types'
import { PlaybackEngine, type EngineStatus, type RepeatMode } from './audio/engine'
import type { StreamEngine } from './audio/stream-engine'
import { createWebAudioGraph } from './audio/web-audio-graph'
import { defaultEqSettings, DEFAULT_MASTER_VOLUME } from './audio/settings'

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
  volume: DEFAULT_MASTER_VOLUME,
  error: null
}

export interface PlaybackControls {
  readonly status: EngineStatus
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
 * ref (the same ref-mirror idiom the two engine hooks use for their inputs)
 * so the engine is still created exactly once on mount.
 */
export function useEngineControls<E extends EngineControlsTarget>(
  create: () => E
): Omit<PlaybackControls, 'engine'> & { engine: E | null } {
  const engineRef = useRef<E | null>(null)
  const createRef = useRef(create)
  createRef.current = create
  const [status, setStatus] = useState<EngineStatus>(IDLE_STATUS)

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

  const call = useCallback((action: (engine: E) => void) => {
    const engine = engineRef.current
    if (engine) action(engine)
  }, [])

  // Individual actions stay referentially stable (all key on `call`), so the
  // memoized table below only rebuilds when the engine instance or its
  // status changes — never on the per-frame position clock, which now lives
  // in NowPlayingBar next to the only slider that reads it.
  const toggle = useCallback(() => call((engine) => void engine.toggle()), [call])
  const next = useCallback(() => call((engine) => void engine.next()), [call])
  const previous = useCallback(() => call((engine) => void engine.previous()), [call])
  const seek = useCallback(
    (position: number) => call((engine) => void engine.seek(position)),
    [call]
  )
  const playAt = useCallback((index: number) => call((engine) => void engine.playAt(index)), [call])
  const playQueue = useCallback(
    (tracks: readonly Track[], startIndex = 0) =>
      call((engine) => {
        engine.setQueue(tracks, startIndex, false)
        void engine.playAt(startIndex)
      }),
    [call]
  )
  const addNext = useCallback(
    (tracks: readonly Track[]) => call((engine) => engine.addNext(tracks)),
    [call]
  )
  const addLast = useCallback(
    (tracks: readonly Track[]) => call((engine) => engine.addLast(tracks)),
    [call]
  )
  const removeAt = useCallback(
    (index: number) => call((engine) => engine.removeAt(index)),
    [call]
  )
  const refreshTracks = useCallback(
    (tracks: readonly Track[]) => call((engine) => engine.refreshTracks(tracks)),
    [call]
  )
  const setEq = useCallback(
    (settings: EqSettings) => call((engine) => engine.setEq(settings)),
    [call]
  )
  const setRepeat = useCallback(
    (mode: RepeatMode) => call((engine) => engine.setRepeat(mode)),
    [call]
  )
  const cycleRepeat = useCallback(() => call((engine) => engine.cycleRepeat()), [call])
  const setShuffle = useCallback(
    (on: boolean) => call((engine) => engine.setShuffle(on)),
    [call]
  )
  const toggleShuffle = useCallback(() => call((engine) => engine.toggleShuffle()), [call])
  const setVolume = useCallback((volume: number) => call((engine) => engine.setVolume(volume)), [call])

  const engine = engineRef.current
  return useMemo(
    () => ({
      status,
      engine,
      toggle,
      next,
      previous,
      seek,
      playAt,
      playQueue,
      addNext,
      addLast,
      removeAt,
      refreshTracks,
      setEq,
      setRepeat,
      cycleRepeat,
      setShuffle,
      toggleShuffle,
      setVolume
    }),
    [
      status,
      engine,
      toggle,
      next,
      previous,
      seek,
      playAt,
      playQueue,
      addNext,
      addLast,
      removeAt,
      refreshTracks,
      setEq,
      setRepeat,
      cycleRepeat,
      setShuffle,
      toggleShuffle,
      setVolume
    ]
  )
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
