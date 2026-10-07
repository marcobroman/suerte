import type { EqSettings } from '@shared/types'
import type { AnalyserLike, AudioBufferLike, MediaElementLike } from '@/audio/graph'
import type { ResolvedGraphSettings } from '@/audio/settings'

export class FakeBuffer {
  readonly duration: number
  readonly sampleRate = 48000
  readonly numberOfChannels = 2
  readonly length: number

  constructor(durationSec: number) {
    this.duration = durationSec
    this.length = Math.round(durationSec * this.sampleRate)
  }
}

export class FakeVoice {
  startedAt: number | null = null
  stopCount = 0
  readonly #onEnded: () => void

  constructor(onEnded: () => void) {
    this.#onEnded = onEnded
  }

  start(offsetSec: number): void {
    this.startedAt = offsetSec
  }

  stop(): void {
    this.stopCount += 1
  }

  /** Simulates the buffer playing out to its end. */
  finish(): void {
    this.#onEnded()
  }
}

export class FakeAnalyser implements AnalyserLike {
  readonly fftSize = 2048
  frequencyBinCount = 1024
  readonly filled: number[] = []

  getByteFrequencyData(array: Uint8Array): void {
    array.fill(0)
  }

  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128)
  }
}

export class FakeGraph {
  sampleRate = 48000
  currentTime = 0
  readonly analyser = new FakeAnalyser()
  voices: FakeVoice[] = []
  decodes: number[] = []
  lastSettings: ResolvedGraphSettings | null = null
  lastVolume = 1
  resumeCount = 0
  closeCount = 0
  /** When set, decode rejects with this error. */
  decodeError: Error | null = null

  createVoice(_buffer: AudioBufferLike, onEnded: () => void): FakeVoice {
    const voice = new FakeVoice(onEnded)
    this.voices.push(voice)
    return voice
  }

  mediaAttachments = 0

  attachMediaElement(_element: MediaElementLike): () => void {
    this.mediaAttachments += 1
    return () => {
      this.mediaAttachments -= 1
    }
  }

  async decode(bytes: ArrayBuffer): Promise<FakeBuffer> {
    if (this.decodeError) throw this.decodeError
    // Two bytes per frame is enough to recover the duration the engine asked for.
    const frames = Math.max(1, bytes.byteLength / 4)
    this.decodes.push(frames)
    return new FakeBuffer(frames / 48000)
  }

  applySettings(resolved: ResolvedGraphSettings): void {
    this.lastSettings = resolved
    this.lastVolume = resolved.masterGain
  }

  setMasterVolume(linear: number): void {
    this.lastVolume = linear
  }

  setEq(_settings: EqSettings, _frequencies: readonly number[]): void {
    // Coefficient selection is covered by resolveGraphSettings tests.
  }

  async resume(): Promise<void> {
    this.resumeCount += 1
  }

  async suspend(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCount += 1
  }

  /** Moves the transport clock forward, as real playback would. */
  advance(seconds: number): void {
    this.currentTime += seconds
  }

  get lastVoice(): FakeVoice | undefined {
    return this.voices.at(-1)
  }

  /** Voices that were started and not stopped, i.e. currently audible. */
  get liveVoices(): FakeVoice[] {
    return this.voices.filter((voice) => voice.startedAt !== null && voice.stopCount === 0)
  }
}

export class GraphFactory {
  readonly graphs: FakeGraph[] = []
  #sampleRate = 48000
  #failCreate = false

  withSampleRate(sampleRate: number): this {
    this.#sampleRate = sampleRate
    return this
  }

  failing(): this {
    this.#failCreate = true
    return this
  }

  readonly create = (): FakeGraph => {
    if (this.#failCreate) throw new Error('no audio device')
    const graph = new FakeGraph()
    graph.sampleRate = this.#sampleRate
    this.graphs.push(graph)
    return graph
  }

  get current(): FakeGraph {
    const graph = this.graphs.at(-1)
    if (!graph) throw new Error('no graph created yet')
    return graph
  }
}

/** 16 bytes per frame so `bytes / 4` yields the requested duration in seconds. */
export function audioBytesForDuration(durationSec: number): ArrayBuffer {
  return new ArrayBuffer(Math.max(4, Math.round(durationSec * 48000) * 4))
}
