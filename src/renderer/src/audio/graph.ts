import type { EqSettings } from '@shared/types'
import type { ResolvedGraphSettings } from './settings'

/** Structural subset of `AudioBuffer` the engine relies on. */
export interface AudioBufferLike {
  readonly duration: number
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly length: number
}

export interface Voice {
  /** Begins playback at an offset into the buffer. */
  start(offsetSec: number): void
  /** Stops early. The engine treats this as intentional, not a track ending. */
  stop(): void
}

/** Structural subset of `AnalyserNode` for the visualiser. */
export interface AnalyserLike {
  readonly fftSize: number
  frequencyBinCount: number
  getByteFrequencyData(array: Uint8Array): void
  getByteTimeDomainData(array: Uint8Array): void
}

/**
 * Everything the playback engine needs from Web Audio. Keeping it behind an
 * interface lets the transport logic be exercised without an AudioContext, which
 * Node does not provide.
 */
export interface PlaybackGraph {
  readonly sampleRate: number
  readonly currentTime: number
  readonly analyser: AnalyserLike
  /** Detaches `bytes`; callers must pass a copy they own. */
  decode(bytes: ArrayBuffer): Promise<AudioBufferLike>
  createVoice(buffer: AudioBufferLike, onEnded: () => void): Voice
  applySettings(resolved: ResolvedGraphSettings): void
  setMasterVolume(linear: number): void
  setEq(settings: EqSettings, bandFrequenciesHz: readonly number[]): void
  resume(): Promise<void>
  suspend(): Promise<void>
  close(): Promise<void>
}
