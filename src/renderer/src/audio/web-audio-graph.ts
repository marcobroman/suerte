import { BAND_Q, BANDS, BASS_SHELF_HZ, SHELF_Q, TREBLE_SHELF_HZ } from './bands'
import type { AnalyserLike, AudioBufferLike, PlaybackGraph, Voice } from './graph'
import { clampMasterVolume, resolveGraphSettings } from './settings'

const FFT_SIZE = 2048

/**
 * Live Web Audio chain:
 *
 *   source -> preamp -> 10 peaking bands -> bass shelf -> treble shelf
 *          -> master -> analyser -> destination
 *
 * All filter nodes are created once and stay connected. Web Audio recomputes
 * biquad coefficients whenever frequency, Q or gain changes, so moving a slider is
 * a property write rather than a graph rebuild, which would click.
 */
export function createWebAudioGraph(): PlaybackGraph {
  let context: AudioContext | null = null
  let preamp: GainNode | null = null
  let master: GainNode | null = null
  let analyserNode: AnalyserNode | null = null
  let bandNodes: BiquadFilterNode[] = []
  let bassNode: BiquadFilterNode | null = null
  let trebleNode: BiquadFilterNode | null = null

  const ensureContext = (): AudioContext => {
    if (context) return context

    const ctx = new AudioContext({ latencyHint: 'interactive' })
    const preampNode = new GainNode(ctx, { gain: 1 })
    const masterNode = new GainNode(ctx, { gain: 1 })
    const analyser = new AnalyserNode(ctx, { fftSize: FFT_SIZE })
    analyser.smoothingTimeConstant = 0.75

    const nodes = BANDS.map(
      (band) =>
        new BiquadFilterNode(ctx, {
          type: 'peaking',
          frequency: band.frequencyHz,
          Q: BAND_Q
        })
    )
    const bass = new BiquadFilterNode(ctx, {
      type: 'lowshelf',
      frequency: BASS_SHELF_HZ,
      Q: SHELF_Q
    })
    const treble = new BiquadFilterNode(ctx, {
      type: 'highshelf',
      frequency: TREBLE_SHELF_HZ,
      Q: SHELF_Q
    })

    context = ctx
    preamp = preampNode
    master = masterNode
    analyserNode = analyser
    bandNodes = nodes
    bassNode = bass
    trebleNode = treble

    let node: AudioNode = preampNode
    for (const band of nodes) {
      node.connect(band)
      node = band
    }
    node.connect(bass)
    node.connect(treble)
    node.connect(masterNode)
    masterNode.connect(analyser)
    analyser.connect(ctx.destination)

    return ctx
  }

  const requireAnalyser = (): AnalyserLike => {
    ensureContext()
    return analyserNode as unknown as AnalyserLike
  }

  return {
    get sampleRate(): number {
      return ensureContext().sampleRate
    },
    get currentTime(): number {
      return context?.currentTime ?? 0
    },
    get analyser(): AnalyserLike {
      return requireAnalyser()
    },

    async decode(bytes: ArrayBuffer): Promise<AudioBufferLike> {
      const ctx = ensureContext()
      // decodeAudioData detaches the buffer it is given, so it is consumed.
      return ctx.decodeAudioData(bytes)
    },

    createVoice(buffer: AudioBufferLike, onEnded: () => void): Voice {
      const ctx = ensureContext()
      const source = new AudioBufferSourceNode(ctx, { buffer: buffer as AudioBuffer })
      source.connect(preamp as GainNode)

      let finished = false
      const handleEnded = (): void => {
        if (finished) return
        finished = true
        try {
          source.disconnect()
        } catch {
          // Already torn down with the context.
        }
        onEnded()
      }
      source.onended = handleEnded

      return {
        start(offsetSec: number): void {
          source.start(0, offsetSec)
        },
        stop(): void {
          // stop() fires onended; the engine's generation guard ignores it. A node
          // that already ended cannot be stopped again, hence the finished check.
          if (finished) return
          source.stop()
        }
      }
    },

    applySettings(resolved: ReturnType<typeof resolveGraphSettings>): void {
      ensureContext()
      const now = context?.currentTime ?? 0
      setParam(preamp?.gain, resolved.preampGain, now)
      for (const [index, band] of resolved.bands.entries()) {
        const node = bandNodes[index]
        if (!node) continue
        setParam(node.frequency, band.frequencyHz, now)
        setParam(node.Q, band.q, now)
        setParam(node.gain, band.gainDb, now)
      }
      if (bassNode) {
        setParam(bassNode.gain, resolved.bass.gainDb, now)
        setParam(bassNode.Q, resolved.bass.q, now)
      }
      if (trebleNode) {
        setParam(trebleNode.gain, resolved.treble.gainDb, now)
        setParam(trebleNode.Q, resolved.treble.q, now)
      }
      setParam(master?.gain, resolved.masterGain, now)
    },

    setMasterVolume(linear: number): void {
      ensureContext()
      setParam(master?.gain, clampMasterVolume(linear), context?.currentTime ?? 0)
    },

    setEq(settings: Parameters<typeof resolveGraphSettings>[0], bandFrequenciesHz: readonly number[]): void {
      this.applySettings(resolveGraphSettings(settings, this.sampleRate, bandFrequenciesHz))
    },

    async resume(): Promise<void> {
      await ensureContext().resume()
    },
    async suspend(): Promise<void> {
      if (context && context.state === 'running') await context.suspend()
    },
    async close(): Promise<void> {
      if (!context) return
      const closing = context
      context = null
      await closing.close()
    }
  }
}

/**
 * Ramps to avoid zipper noise and pops. A 5 ms ramp is short enough to feel
 * immediate and long enough to suppress clicks.
 */
function setParam(param: AudioParam | undefined, value: number, now: number): void {
  if (!param) return
  if (!Number.isFinite(value)) return
  param.cancelScheduledValues(now)
  param.setTargetAtTime(value, now, 0.005)
}
