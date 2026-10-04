import type { EqSettings, Track } from '@shared/types'
import { ISO_BAND_FREQUENCIES } from './bands'
import { LruCache } from './buffer-cache'
import type { AudioBufferLike, PlaybackGraph, Voice } from './graph'
import { clampMasterVolume, defaultEqSettings } from './settings'

export type EngineState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface EngineStatus {
  readonly state: EngineState
  readonly track: Track | null
  readonly index: number
  readonly queue: readonly Track[]
  readonly queueLength: number
  readonly positionSec: number
  readonly durationSec: number
  readonly volume: number
  readonly error: string | null
}

export interface EngineOptions {
  createGraph(): PlaybackGraph
  readFile(path: string): Promise<ArrayBuffer>
  readonly cacheSize?: number
  onChange?(status: EngineStatus): void
  /** Fired when the final track reaches its end, for UI affordances. */
  onQueueEnd?(): void
}

export const DEFAULT_BUFFER_CACHE_SIZE = 5

/**
 * Starting at or after the buffer length yields silence or throws, so offsets are
 * held a hair below the end.
 */
const END_GUARD_SEC = 0.01

export class PlaybackEngine {
  readonly #options: EngineOptions
  readonly #cache: LruCache<string, AudioBufferLike>
  readonly #inflight = new Map<string, Promise<AudioBufferLike>>()
  readonly #listeners = new Set<(status: EngineStatus) => void>()

  #queue: readonly Track[] = []
  #index = -1
  #graph: PlaybackGraph | null = null
  #buffer: AudioBufferLike | null = null
  #voice: Voice | null = null
  #eq: EqSettings = defaultEqSettings()
  #volume: number
  #state: EngineState = 'idle'
  #error: string | null = null
  #offsetSec = 0
  #startedAt = 0
  #durationSec = 0

  /**
   * Bumped on every start and stop. `onended` fires for intentional stops too, so
   * a stale voice's callback is discarded instead of advancing the queue.
   */
  #generation = 0

  /** In-flight automatic transition (track end, queue replacement). */
  #transition: Promise<void> | null = null

  constructor(options: EngineOptions) {
    this.#options = options
    this.#cache = new LruCache(options.cacheSize ?? DEFAULT_BUFFER_CACHE_SIZE)
    this.#volume = this.#eq.masterVolume
  }

  get state(): EngineState {
    return this.#state
  }

  get queue(): readonly Track[] {
    return this.#queue
  }

  get eq(): EqSettings {
    return this.#eq
  }

  status(): EngineStatus {
    const track = this.#queue[this.#index] ?? null
    return {
      state: this.#state,
      track,
      index: this.#index,
      queue: [...this.#queue],
      queueLength: this.#queue.length,
      positionSec: this.position(),
      durationSec: this.#durationSec,
      volume: this.#volume,
      error: this.#error
    }
  }

  position(): number {
    if (this.#state === 'playing' && this.#graph) {
      const elapsed = this.#graph.currentTime - this.#startedAt
      return clampRange(this.#offsetSec + elapsed, 0, this.#durationSec)
    }
    return this.#offsetSec
  }

  /**
   * Resolves once any automatic track transition has finished. Automatic advances
   * are fire-and-forget by nature, so this is how a caller sequences work after
   * one; it also makes those paths observable in tests.
   */
  async settled(): Promise<void> {
    while (this.#transition) {
      const current = this.#transition
      await current
      if (this.#transition === current) this.#transition = null
    }
  }

  subscribe(listener: (status: EngineStatus) => void): () => void {
    this.#listeners.add(listener)
    listener(this.status())
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Replaces the queue. The currently loaded track keeps playing if it survives the
   * change, so a background rescan does not interrupt playback. Passing a
   * `startIndex` means the caller is choosing what plays, which wins over tracking
   * the previous track; pass `preservePlayback: false` to stop the old track.
   */
  setQueue(tracks: readonly Track[], startIndex = -1, preservePlayback = true): void {
    const previous = this.#queue[this.#index] ?? null
    const wasActive = preservePlayback && (this.#state === 'playing' || this.#state === 'loading')
    const previousOffset = this.position()

    const next = [...tracks]
    const kept = previous !== null ? next.findIndex((t) => t.path === previous.path) : -1

    // An explicit startIndex means the caller is choosing what plays: it wins over
    // tracking the previous track. Only background queue refreshes (startIndex < 0)
    // keep the current audio running without a gap.
    if (kept >= 0 && startIndex < 0) {
      // The same audio is already running or is being loaded. Only bookkeeping changes,
      // so navigation never produces an audible gap.
      const wasPlaying = this.#state === 'playing'
      const voiceExists = this.#voice !== null
      this.#queue = next
      this.#index = kept
      this.#durationSec = this.#queue[kept]?.durationSec ?? this.#durationSec
      if (wasPlaying && voiceExists) {
        this.#emit()
        return
      }
      this.#emit()
      return
    }

    this.#stopVoice()
    this.#queue = next
    this.#buffer = null
    this.#error = null
    this.#state = 'idle'

    let index = startIndex
    if (previous && startIndex < 0) {
      const found = this.#queue.findIndex((track) => track.path === previous.path)
      if (found >= 0) index = found
    }
    this.#index = index
    this.#offsetSec = index >= 0 ? previousOffset : 0
    this.#durationSec = this.#queue[index]?.durationSec ?? 0
    this.#emit()

    if (wasActive && index >= 0) this.#beginTransition(this.#startAt(index, this.#offsetSec))
  }

  async play(): Promise<void> {
    if (this.#queue.length === 0) return
    const index = this.#index
    if (index < 0) {
      await this.#startAt(0, 0)
      return
    }
    if (this.#state === 'playing' || this.#state === 'loading') return

    const track = this.#queue[index]
    if (!track) return

    const atEnd = this.#offsetSec >= this.#durationSec - END_GUARD_SEC
    const offset = atEnd ? 0 : this.#offsetSec
    await this.#startAt(index, offset)
  }

  pause(): void {
    if (this.#state !== 'playing') return
    // Freeze the position before the state changes, while the clock is still live.
    this.#offsetSec = this.position()
    this.#stopVoice()
    this.#state = 'paused'
    this.#emit()
  }

  async toggle(): Promise<void> {
    if (this.#state === 'playing') this.pause()
    else await this.play()
  }

  async seek(positionSec: number): Promise<void> {
    const index = this.#index
    if (index < 0) return
    const track = this.#queue[index]
    if (!track) return
    const wasPlaying = this.#state === 'playing'

    let buffer = this.#buffer
    if (!buffer) {
      try {
        buffer = await this.loadBuffer(track.path)
      } catch (error) {
        this.#fail(error)
        return
      }
      if (this.#index !== index) return
    }

    const target = clampRange(positionSec, 0, buffer.duration)
    if (wasPlaying) {
      this.#stopVoice()
      this.#state = 'playing'
      this.#startVoice(buffer, target)
    } else {
      this.#offsetSec = target
      this.#durationSec = buffer.duration
    }
    this.#emit()
  }

  async next(): Promise<void> {
    const target = this.#index + 1
    if (target >= this.#queue.length) return
    await this.#startAt(target, 0)
  }

  async previous(): Promise<void> {
    if (this.#index <= 0) {
      if (this.#index === 0) await this.#startAt(0, 0)
      return
    }
    await this.#startAt(this.#index - 1, 0)
  }

  async playAt(index: number): Promise<void> {
    if (index < 0 || index >= this.#queue.length) return
    await this.#startAt(index, 0)
  }

  /**
   * Swaps queued entries for fresh metadata (after a tag edit + rescan) without
   * touching playback: same order, same index, same voice. Entries missing from
   * the fresh list are kept as-is, so deletions never yank the queue.
   */
  refreshTracks(tracks: readonly Track[]): void {
    const fresh = new Map(tracks.map((track) => [track.path, track] as const))
    let changed = false
    const next = this.#queue.map((entry) => {
      const replacement = fresh.get(entry.path)
      if (replacement && replacement !== entry) {
        changed = true
        return replacement
      }
      return entry
    })
    if (!changed) return
    this.#queue = next
    this.#emit()
  }

  /**
   * Inserts tracks right after the current one, so they play next. With an empty
   * queue (or nothing selected) the tracks are appended instead. Never interrupts
   * the running voice; it only splices the upcoming order.
   */
  addNext(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    const at = this.#index >= 0 ? this.#index + 1 : this.#queue.length
    this.#queue = [...this.#queue.slice(0, at), ...tracks, ...this.#queue.slice(at)]
    this.#emit()
  }

  /** Appends tracks to the end of the queue without touching playback. */
  addLast(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    this.#queue = [...this.#queue, ...tracks]
    this.#emit()
  }

  /**
   * Removes one queued entry. Removing the track that is currently playing moves
   * playback onto the track that slides into its place (or stops when none is
   * left); removing anything else keeps the current audio running.
   */
  removeAt(index: number): void {
    if (index < 0 || index >= this.#queue.length) return
    const wasCurrent = index === this.#index
    const wasActive =
      wasCurrent && (this.#state === 'playing' || this.#state === 'loading')

    if (!wasCurrent) {
      this.#queue = [...this.#queue.slice(0, index), ...this.#queue.slice(index + 1)]
      if (index < this.#index) this.#index -= 1
      this.#emit()
      return
    }

    this.#stopVoice()
    const next = [...this.#queue.slice(0, index), ...this.#queue.slice(index + 1)]
    this.#queue = next
    this.#buffer = null
    this.#error = null
    if (index < next.length) {
      this.#index = index
      this.#offsetSec = 0
      this.#durationSec = next[index]?.durationSec ?? 0
      this.#state = 'idle'
      this.#emit()
      if (wasActive) this.#beginTransition(this.#startAt(index, 0))
      return
    }
    this.#index = -1
    this.#offsetSec = 0
    this.#durationSec = 0
    this.#state = 'idle'
    this.#emit()
  }

  setEq(settings: EqSettings): void {
    this.#eq = settings
    this.#volume = clampMasterVolume(settings.masterVolume)
    this.#graph?.setEq(settings, ISO_BAND_FREQUENCIES)
    this.#emit()
  }

  setVolume(linear: number): void {
    this.#volume = clampMasterVolume(linear)
    this.#graph?.setMasterVolume(this.#volume)
    this.#emit()
  }

  /** Cached decode of a track, reading and decoding on a miss. */
  async loadBuffer(path: string): Promise<AudioBufferLike> {
    const cached = this.#cache.get(path)
    if (cached) return cached

    const existing = this.#inflight.get(path)
    if (existing) return existing

    const work = (async () => {
      const graph = this.#ensureGraph()
      const bytes = await this.#options.readFile(path)
      // decodeAudioData detaches its input, so hand it a copy we do not reuse.
      const decoded = await graph.decode(bytes.slice(0))
      this.#cache.set(path, decoded)
      return decoded
    })()

    this.#inflight.set(path, work)
    const clear = (): void => {
      if (this.#inflight.get(path) === work) this.#inflight.delete(path)
    }
    void work.then(clear, clear)
    return work
  }

  async dispose(): Promise<void> {
    this.#stopVoice()
    this.#listeners.clear()
    this.#cache.clear()
    this.#inflight.clear()
    this.#queue = []
    this.#index = -1
    this.#state = 'idle'
    const graph = this.#graph
    this.#graph = null
    await graph?.close()
  }

  async #startAt(index: number, offsetSec: number): Promise<void> {
    const track = this.#queue[index]
    if (!track) return

    this.#stopVoice()
    this.#index = index
    this.#buffer = null
    this.#error = null
    this.#offsetSec = 0
    this.#durationSec = track.durationSec
    this.#state = 'loading'
    this.#emit()

    let buffer: AudioBufferLike
    try {
      buffer = await this.loadBuffer(track.path)
    } catch (error) {
      if (this.#index !== index) return
      this.#fail(error)
      return
    }

    // The selection may have moved on while the file was being decoded.
    if (this.#index !== index) return

    // The context may have been created suspended; play() originates from a gesture.
    await this.#ensureGraph().resume()
    if (this.#index !== index) return

    this.#state = 'playing'
    this.#startVoice(buffer, offsetSec)
    this.#emit()
  }

  #startVoice(buffer: AudioBufferLike, offsetSec: number): void {
    const graph = this.#ensureGraph()
    const generation = ++this.#generation

    this.#buffer = buffer
    this.#durationSec = buffer.duration
    this.#offsetSec = clampRange(offsetSec, 0, Math.max(0, buffer.duration - END_GUARD_SEC))
    this.#startedAt = graph.currentTime

    const voice = graph.createVoice(buffer, () => {
      this.#handleVoiceEnded(generation)
    })
    this.#voice = voice
    voice.start(this.#offsetSec)
  }

  #stopVoice(): void {
    this.#generation += 1
    const voice = this.#voice
    this.#voice = null
    voice?.stop()
  }

  #handleVoiceEnded(generation: number): void {
    if (generation !== this.#generation) return
    this.#voice = null

    const isLast = this.#index >= this.#queue.length - 1
    if (isLast) {
      this.#offsetSec = this.#durationSec
      this.#state = 'paused'
      this.#emit()
      this.#options.onQueueEnd?.()
      return
    }
    this.#beginTransition(this.#startAt(this.#index + 1, 0))
  }

  #beginTransition(work: Promise<void>): void {
    const tracked = work.catch(() => {})
    this.#transition = tracked
    const clear = (): void => {
      if (this.#transition === tracked) this.#transition = null
    }
    void tracked.then(clear, clear)
  }

  #fail(error: unknown): void {
    this.#state = 'error'
    this.#error = describeError(error)
    this.#emit()
  }

  #ensureGraph(): PlaybackGraph {
    if (!this.#graph) {
      this.#graph = this.#options.createGraph()
      this.#graph.setEq(this.#eq, ISO_BAND_FREQUENCIES)
      this.#graph.setMasterVolume(this.#volume)
    }
    return this.#graph
  }

  #emit(): void {
    if (this.#listeners.size === 0) return
    const snapshot = this.status()
    this.#options.onChange?.(snapshot)
    for (const listener of this.#listeners) listener(snapshot)
  }
}

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
