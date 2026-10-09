import type { EqSettings, Track } from '@shared/types'
import { ISO_BAND_FREQUENCIES } from './bands'
import type { EngineStatus, RepeatMode } from './engine'
import type { MediaElementLike, PlaybackGraph } from './graph'
import { clampMasterVolume, defaultEqSettings } from './settings'

export interface StreamEngineOptions {
  createGraph(): PlaybackGraph
  createAudio(): MediaElementLike
  /** Maps a library path to a playable stream URL. Wired by the HTTP backend. */
  streamUrl(path: string): string
  /**
   * Fired when the element errors (no HTTP status available from tags): the
   * phone wiring re-probes auth here so a dead credential routes to boot
   * instead of leaving "Playback failed." on screen.
   */
  onMediaError?(): void
  onChange?(status: EngineStatus): void
  /** Fired when the final track reaches its end, for UI affordances. */
  onQueueEnd?(): void
}

/**
 * PlaybackEngine's twin for streaming: identical queue, repeat, shuffle, EQ,
 * and status semantics, but the transport is an <audio>-style element fed from
 * URLs instead of decoded buffers. Nothing here decodes, caches, or prefetches;
 * seeking rides on server byte ranges.
 */
export class StreamEngine {
  readonly #options: StreamEngineOptions
  readonly #listeners = new Set<(status: EngineStatus) => void>()

  #queue: readonly Track[] = []
  #index = -1
  #graph: PlaybackGraph | null = null
  #detachMedia: (() => void) | null = null
  #element: MediaElementLike
  #loadedPath: string | null = null
  #pendingOffset: number | null = null
  #eq: EqSettings = defaultEqSettings()
  #volume: number
  #repeat: RepeatMode = 'off'
  #shuffle = false
  #unshuffled: readonly Track[] | null = null
  #state: EngineStatus['state'] = 'idle'
  #error: string | null = null
  #offsetSec = 0
  #durationSec = 0
  #generation = 0
  #activeGeneration = 0
  #transition: Promise<void> | null = null

  constructor(options: StreamEngineOptions) {
    this.#options = options
    this.#volume = this.#eq.masterVolume
    const element = options.createAudio()
    this.#element = element
    element.addEventListener('ended', this.#onEnded)
    element.addEventListener('error', this.#onError)
    element.addEventListener('loadedmetadata', this.#onMetadata)
  }

  get state(): EngineStatus['state'] {
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
      eq: { ...this.#eq, bandGainsDb: [...this.#eq.bandGainsDb] },
      repeat: this.#repeat,
      shuffle: this.#shuffle,
      positionSec: this.position(),
      durationSec: this.#durationSec,
      volume: this.#volume,
      error: this.#error
    }
  }

  position(): number {
    // A pending seek is where playback is heading; report it rather than the
    // stale element clock so the slider jumps at once.
    if (this.#pendingOffset !== null) return this.#offsetSec
    if (this.#state === 'playing') {
      const current = this.#element.currentTime
      if (Number.isFinite(current)) return clampRange(current, 0, this.#durationSec)
      return this.#offsetSec
    }
    return this.#offsetSec
  }

  /**
   * Resolves once any automatic track transition has finished. Mirror of the
   * buffer engine's contract, so shared UI helpers keep working.
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
   * Replaces the queue. Same contract as the buffer engine: an explicit
   * `startIndex` (or opting out of preservation) chooses what plays and clears
   * any shuffle; a background refresh only repoints bookkeeping and never
   * interrupts the running element.
   */
  setQueue(tracks: readonly Track[], startIndex = -1, preservePlayback = true): void {
    this.#shuffle = false
    this.#unshuffled = null

    const previous = this.#queue[this.#index] ?? null
    const wasActive = preservePlayback && (this.#state === 'playing' || this.#state === 'loading')
    const previousOffset = this.position()

    const next = [...tracks]
    const kept = previous !== null ? next.findIndex((t) => t.path === previous.path) : -1

    if (kept >= 0 && startIndex < 0) {
      this.#queue = next
      this.#index = kept
      this.#durationSec = this.#queue[kept]?.durationSec ?? this.#durationSec
      this.#emit()
      return
    }

    this.#stopAudio()
    this.#queue = next
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
    this.#offsetSec = this.position()
    this.#stopAudio()
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

    const ceiling = this.#durationSec > 0 ? this.#durationSec : track.durationSec
    const target = clampRange(positionSec, 0, ceiling > 0 ? ceiling : positionSec)
    this.#offsetSec = target
    if (this.#loadedPath === track.path && this.#element.readyState >= 1) {
      try {
        this.#element.currentTime = target
        this.#pendingOffset = null
      } catch {
        this.#pendingOffset = target
      }
    } else {
      this.#pendingOffset = target
    }
    this.#emit()
  }

  async next(): Promise<void> {
    const target = this.#index + 1
    if (target >= this.#queue.length) {
      if (this.#repeat === 'all' && this.#queue.length > 0) {
        await this.#startAt(0, 0)
      }
      return
    }
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

  refreshTracks(tracks: readonly Track[]): void {
    const fresh = new Map(tracks.map((track) => [track.path, track] as const))
    const remap = (entries: readonly Track[]): { list: readonly Track[]; changed: boolean } => {
      let changed = false
      const list = entries.map((entry) => {
        const replacement = fresh.get(entry.path)
        if (replacement && replacement !== entry) {
          changed = true
          return replacement
        }
        return entry
      })
      return { list, changed }
    }
    const queue = remap(this.#queue)
    const saved = this.#unshuffled ? remap(this.#unshuffled) : null
    if (!queue.changed && !saved?.changed) return
    this.#queue = queue.list
    if (saved) this.#unshuffled = saved.list
    this.#emit()
  }

  addNext(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    const current = this.#index >= 0 ? (this.#queue[this.#index] ?? null) : null
    const at = current !== null ? this.#index + 1 : this.#queue.length
    this.#queue = [...this.#queue.slice(0, at), ...tracks, ...this.#queue.slice(at)]
    if (this.#unshuffled) {
      const savedAt =
        current !== null ? this.#unshuffled.indexOf(current) + 1 : this.#unshuffled.length
      this.#unshuffled = [
        ...this.#unshuffled.slice(0, savedAt),
        ...tracks,
        ...this.#unshuffled.slice(savedAt)
      ]
    }
    this.#emit()
  }

  addLast(tracks: readonly Track[]): void {
    if (tracks.length === 0) return
    this.#queue = [...this.#queue, ...tracks]
    if (this.#unshuffled) this.#unshuffled = [...this.#unshuffled, ...tracks]
    this.#emit()
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.#queue.length) return
    const removed = this.#queue[index]
    const wasCurrent = index === this.#index
    const wasActive =
      wasCurrent && (this.#state === 'playing' || this.#state === 'loading')

    if (this.#unshuffled && removed) {
      const savedAt = this.#unshuffled.indexOf(removed)
      if (savedAt >= 0) {
        this.#unshuffled = [
          ...this.#unshuffled.slice(0, savedAt),
          ...this.#unshuffled.slice(savedAt + 1)
        ]
      }
    }

    if (!wasCurrent) {
      this.#queue = [...this.#queue.slice(0, index), ...this.#queue.slice(index + 1)]
      if (index < this.#index) this.#index -= 1
      this.#emit()
      return
    }

    this.#stopAudio()
    const next = [...this.#queue.slice(0, index), ...this.#queue.slice(index + 1)]
    this.#queue = next
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
    this.#eq = { ...this.#eq, masterVolume: this.#volume }
    this.#graph?.setMasterVolume(this.#volume)
    this.#emit()
  }

  /** Unknown modes are ignored rather than wedging playback into a bad state. */
  setRepeat(mode: RepeatMode): void {
    if (mode !== 'off' && mode !== 'all' && mode !== 'one') return
    if (mode === this.#repeat) return
    this.#repeat = mode
    this.#emit()
  }

  /** Cycles off → all → one, the standard transport order. */
  cycleRepeat(): void {
    this.setRepeat(this.#repeat === 'off' ? 'all' : this.#repeat === 'all' ? 'one' : 'off')
  }

  /**
   * Shuffles the queue with the current track first, so Up next reads top to
   * bottom from what's playing. Playback itself never jumps: the element keeps
   * running and only bookkeeping changes.
   */
  setShuffle(on: boolean): void {
    if (on === this.#shuffle) return
    if (!on) {
      const current = this.#index >= 0 ? (this.#queue[this.#index] ?? null) : null
      if (this.#unshuffled) this.#queue = [...this.#unshuffled]
      this.#unshuffled = null
      this.#index = current !== null ? this.#queue.findIndex((track) => track === current) : -1
      if (this.#index < 0) {
        this.#offsetSec = 0
        this.#durationSec = 0
      }
      this.#shuffle = false
      this.#emit()
      return
    }
    const current = this.#index >= 0 ? (this.#queue[this.#index] ?? null) : null
    this.#unshuffled = [...this.#queue]
    const rest = this.#queue.filter((track) => track !== current)
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const atI = rest[i]
      const atJ = rest[j]
      if (atI === undefined || atJ === undefined) continue
      rest[i] = atJ
      rest[j] = atI
    }
    this.#queue = current !== null ? [current, ...rest] : rest
    this.#index = current !== null ? 0 : -1
    this.#shuffle = true
    this.#emit()
  }

  toggleShuffle(): void {
    this.setShuffle(!this.#shuffle)
  }

  async dispose(): Promise<void> {
    this.#stopAudio()
    this.#element.removeEventListener('ended', this.#onEnded)
    this.#element.removeEventListener('error', this.#onError)
    this.#element.removeEventListener('loadedmetadata', this.#onMetadata)
    this.#detachMedia?.()
    this.#detachMedia = null
    this.#listeners.clear()
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

    this.#stopAudio()
    this.#index = index
    this.#error = null
    this.#offsetSec = 0
    this.#durationSec = track.durationSec
    this.#state = 'loading'
    this.#activeGeneration = ++this.#generation
    const generation = this.#activeGeneration
    this.#emit()

    if (this.#loadedPath !== track.path) {
      this.#element.src = this.#options.streamUrl(track.path)
      this.#loadedPath = track.path
    }
    this.#pendingOffset = offsetSec > 0 ? offsetSec : null

    try {
      await this.#ensureGraph().resume()
    } catch (error: unknown) {
      if (this.#index !== index) return
      this.#fail(error)
      return
    }
    if (this.#index !== index) return

    // A replayed track must restart even when its source is already loaded:
    // unlike a fresh buffer voice, the element keeps its old clock unless told.
    try {
      this.#element.currentTime = offsetSec
      this.#offsetSec = offsetSec
      this.#pendingOffset = null
    } catch {
      this.#pendingOffset = offsetSec > 0 ? offsetSec : null
    }
    try {
      await this.#element.play()
    } catch (error: unknown) {
      if (this.#index !== index) return
      this.#fail(error)
      return
    }
    if (this.#index !== index || generation !== this.#generation) return

    if (this.#pendingOffset !== null) {
      try {
        this.#element.currentTime = this.#pendingOffset
        this.#offsetSec = this.#pendingOffset
      } catch {
        // Metadata is not there yet; the metadata listener retries.
      } finally {
        if (Number.isFinite(this.#element.currentTime)) this.#pendingOffset = null
      }
    }
    this.#state = 'playing'
    this.#emit()
  }

  #stopAudio(): void {
    this.#generation += 1
    try {
      this.#element.pause()
    } catch {
      // Pausing an unsettled element must never break queue bookkeeping.
    }
  }

  #onEnded = (): void => {
    if (this.#activeGeneration !== this.#generation) return
    const isLast = this.#index >= this.#queue.length - 1
    if (this.#repeat === 'one' && this.#index >= 0 && this.#index < this.#queue.length) {
      this.#beginTransition(this.#startAt(this.#index, 0))
      return
    }
    if (isLast) {
      if (this.#repeat === 'all' && this.#queue.length > 0) {
        this.#beginTransition(this.#startAt(0, 0))
        return
      }
      this.#offsetSec = this.#durationSec
      this.#state = 'paused'
      this.#emit()
      this.#options.onQueueEnd?.()
      return
    }
    this.#beginTransition(this.#startAt(this.#index + 1, 0))
  }

  #onError = (): void => {
    if (this.#state !== 'playing' && this.#state !== 'loading') return
    this.#options.onMediaError?.()
    this.#fail(new Error('Playback failed.'))
  }

  #onMetadata = (): void => {
    const duration = this.#element.duration
    if (Number.isFinite(duration) && duration > 0) this.#durationSec = duration
    if (this.#pendingOffset !== null) {
      try {
        this.#element.currentTime = this.#pendingOffset
        this.#pendingOffset = null
      } catch {
        // Not seekable yet; a later event or play retries.
      }
    }
    this.#emit()
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
    this.#error = error instanceof Error ? error.message : String(error)
    this.#emit()
  }

  #ensureGraph(): PlaybackGraph {
    if (!this.#graph) {
      this.#graph = this.#options.createGraph()
      this.#graph.setEq(this.#eq, ISO_BAND_FREQUENCIES)
      this.#graph.setMasterVolume(this.#volume)
    }
    if (!this.#detachMedia) {
      this.#detachMedia = this.#graph.attachMediaElement(this.#element)
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

/**
 * Starting at or after the buffer length yields silence or throws, so offsets are
 * held a hair below the end.
 */
const END_GUARD_SEC = 0.01

function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}
