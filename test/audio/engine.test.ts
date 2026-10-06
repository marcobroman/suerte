import { describe, expect, it, vi } from 'vitest'
import { PlaybackEngine } from '@/audio/engine'
import type { Track } from '@shared/types'
import { audioBytesForDuration, GraphFactory } from './fake-graph'

function track(path: string, durationSec: number, title = path): Track {
  return {
    path,
    title,
    artist: 'Artist',
    album: 'Album',
    trackNo: null,
    discNo: null,
    year: null,
    durationSec,
    mtimeMs: 0,
    sizeBytes: 0
  }
}

function makeEngine(queue: readonly Track[] = [], cacheSize?: number) {
  const factory = new GraphFactory()
  const readFile = vi.fn(async (path: string) => audioBytesForDuration(durationOf(path)))
  const engine = new PlaybackEngine({
    createGraph: factory.create,
    readFile,
    ...(cacheSize === undefined ? {} : { cacheSize })
  })
  if (queue.length > 0) engine.setQueue(queue)
  return { engine, factory, readFile }
}

function durationOf(path: string): number {
  return path.includes('long') ? 30 : 10
}

describe('PlaybackEngine', () => {
  it('starts idle with an empty queue', () => {
    const { engine } = makeEngine()
    const status = engine.status()

    expect(status.state).toBe('idle')
    expect(status.index).toBe(-1)
    expect(status.queueLength).toBe(0)
    expect(status.track).toBeNull()
    expect(status.positionSec).toBe(0)
  })

  it('does nothing when playing an empty queue', async () => {
    const { engine, factory } = makeEngine()
    await engine.play()

    expect(engine.state).toBe('idle')
    expect(factory.graphs).toHaveLength(0)
  })

  it('plays the first track and reports position', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    const graph = factory.current
    expect(engine.state).toBe('playing')
    expect(engine.status().index).toBe(0)
    expect(engine.status().durationSec).toBe(10)
    expect(graph.lastVoice?.startedAt).toBe(0)

    graph.advance(4)
    expect(engine.position()).toBeCloseTo(4, 5)
  })

  it('does not create a graph until playback starts', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    expect(factory.graphs).toHaveLength(0)

    await engine.play()
    expect(factory.graphs).toHaveLength(1)
  })

  it('resumes the audio context on play', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    expect(factory.current.resumeCount).toBeGreaterThan(0)
  })

  it('freezes position on pause and resumes from it', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    factory.current.advance(3)

    engine.pause()
    expect(engine.state).toBe('paused')
    expect(engine.position()).toBeCloseTo(3, 5)

    factory.current.advance(10)
    expect(engine.position()).toBeCloseTo(3, 5)

    await engine.play()
    expect(factory.current.lastVoice?.startedAt).toBeCloseTo(3, 5)
  })

  it('stops the voice when pausing', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    engine.pause()

    expect(factory.current.liveVoices).toHaveLength(0)
  })

  it('toggles between play and pause', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])

    await engine.toggle()
    expect(engine.state).toBe('playing')
    await engine.toggle()
    expect(engine.state).toBe('paused')
  })

  it('ignores pause when not playing', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    engine.pause()
    expect(engine.state).toBe('idle')
  })

  it('seeks while playing by restarting the voice at the offset', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    const firstVoice = factory.current.lastVoice

    await engine.seek(6)

    expect(engine.state).toBe('playing')
    expect(firstVoice?.stopCount).toBe(1)
    expect(factory.current.lastVoice?.startedAt).toBe(6)
    expect(engine.position()).toBeCloseTo(6, 5)
  })

  it('seeks while paused without starting a voice', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    engine.pause()
    const before = factory.current.voices.length

    await engine.seek(4)

    expect(engine.state).toBe('paused')
    expect(factory.current.voices).toHaveLength(before)
    expect(engine.position()).toBeCloseTo(4, 5)
  })

  it('clamps seeks to the track bounds', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    await engine.seek(-5)
    expect(engine.position()).toBe(0)

    await engine.seek(999)
    expect(engine.position()).toBeLessThanOrEqual(10)
  })

  it('never starts a voice at or past the buffer end', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    engine.pause()

    await engine.seek(10)
    await engine.play()

    const started = factory.current.lastVoice?.startedAt ?? -1
    expect(started).toBeGreaterThanOrEqual(0)
    expect(started).toBeLessThan(10)
  })

  it('replays from the start when play is pressed at the end', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()
    factory.current.advance(10)
    engine.pause()

    await engine.play()
    expect(factory.current.lastVoice?.startedAt).toBe(0)
  })

  it('advances to the next track when a voice ends', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()

    factory.current.lastVoice?.finish()
    await engine.settled()

    expect(engine.status().index).toBe(1)
    expect(engine.state).toBe('playing')
    expect(engine.status().track?.path).toBe('b.mp3')
  })

  it('does not advance when an intentional stop fires onended', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    const firstVoice = factory.current.lastVoice

    engine.pause()
    firstVoice?.finish()

    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('paused')
  })

  it('does not advance when a seek stops the previous voice', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    const firstVoice = factory.current.lastVoice

    await engine.seek(2)
    firstVoice?.finish()

    expect(engine.status().index).toBe(0)
  })

  it('stops at the end of the queue and reports it', async () => {
    let queueEnded = false
    const factory = new GraphFactory()
    const engine = new PlaybackEngine({
      createGraph: factory.create,
      readFile: async () => audioBytesForDuration(10),
      onQueueEnd: () => {
        queueEnded = true
      }
    })
    engine.setQueue([track('a.mp3', 10)])
    await engine.play()

    factory.current.lastVoice?.finish()

    expect(queueEnded).toBe(true)
    expect(engine.state).toBe('paused')
    expect(engine.position()).toBeCloseTo(10, 5)
  })

  it('steps forward and back explicitly', async () => {
    const { engine } = makeEngine([track('a.mp3', 10), track('b.mp3', 10), track('c.mp3', 10)])
    await engine.play()

    await engine.next()
    expect(engine.status().index).toBe(1)

    await engine.next()
    expect(engine.status().index).toBe(2)

    await engine.previous()
    expect(engine.status().index).toBe(1)
  })

  it('stops advancing past the last track', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    await engine.next()
    expect(engine.status().index).toBe(0)
  })

  it('restarts the current track when previous is pressed on the first', async () => {
    const { engine } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    expect(engine.status().index).toBe(0)

    await engine.next()
    expect(engine.status().index).toBe(1)

    await engine.previous()
    expect(engine.status().index).toBe(0)

    await engine.previous()
    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('playing')
  })

  it('plays a specific index', async () => {
    const { engine } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.playAt(1)

    expect(engine.status().index).toBe(1)
    expect(engine.state).toBe('playing')
  })

  it('ignores an out-of-range index', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.playAt(7)

    expect(engine.status().index).toBe(-1)
    expect(engine.state).toBe('idle')
  })

  it('surfaces a read failure as an error state', async () => {
    const factory = new GraphFactory()
    const engine = new PlaybackEngine({
      createGraph: factory.create,
      readFile: async () => {
        throw new Error('ENOENT: missing.mp3')
      }
    })
    engine.setQueue([track('missing.mp3', 10)])

    await engine.play()

    expect(engine.state).toBe('error')
    expect(engine.status().error).toContain('ENOENT')
  })

  it('surfaces a decode failure as an error state', async () => {
    const factory = new GraphFactory()
    const engine = new PlaybackEngine({
      createGraph: factory.create,
      readFile: async () => audioBytesForDuration(10)
    })
    engine.setQueue([track('a.mp3', 10), track('bad.mp3', 10)])
    await engine.play()

    factory.current.decodeError = new Error('Unable to decode audio data')
    await engine.next()

    expect(engine.state).toBe('error')
    expect(engine.status().error).toContain('Unable to decode')
  })

  it('reuses decoded buffers and evicts the least recently used', async () => {
    const queue = ['a.mp3', 'b.mp3', 'c.mp3'].map((path) => track(path, 10))
    const { engine, readFile } = makeEngine(queue, 2)

    await engine.play()
    await engine.next()
    expect(readFile).toHaveBeenCalledTimes(2)

    // Reading "a" promotes it, so "b" becomes the eviction candidate.
    await engine.playAt(0)
    expect(readFile).toHaveBeenCalledTimes(2)

    await engine.playAt(2)
    expect(readFile).toHaveBeenCalledTimes(3)

    // "b" was evicted to make room, so it has to be read again.
    await engine.playAt(1)
    expect(readFile).toHaveBeenCalledTimes(4)
  })

  it('decodes each path once when the same track repeats', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('a.mp3', 10)])
    await engine.play()
    await engine.next()

    expect(factory.current.decodes).toHaveLength(1)
  })

  it('evicts the least recently used buffer beyond the cache limit', async () => {
    const queue = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'].map((path) => track(path, 10))
    const { engine, readFile } = makeEngine(queue, 2)

    await engine.play()
    await engine.next()
    await engine.next()
    await engine.next()
    expect(readFile).toHaveBeenCalledTimes(4)

    // Only the two most recent are held, so "a" must be fetched again.
    await engine.playAt(0)
    expect(readFile).toHaveBeenCalledTimes(5)
  })

  it('concurrent loads of one path decode only once', async () => {
    const factory = new GraphFactory()
    const readFile = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          pending.push(resolve)
        })
    )
    const pending: Array<(bytes: ArrayBuffer) => void> = []
    const engine = new PlaybackEngine({
      createGraph: factory.create,
      readFile
    })

    const first = engine.loadBuffer('a.mp3')
    const second = engine.loadBuffer('a.mp3')
    for (const resolve of pending) resolve(audioBytesForDuration(10))
    await Promise.all([first, second])

    expect(readFile).toHaveBeenCalledTimes(1)
    expect(factory.current.decodes).toHaveLength(1)
  })

  it('keeps playing the same track when the queue is replaced', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    factory.current.advance(3)

    engine.setQueue([track('c.mp3', 10), track('a.mp3', 10), track('d.mp3', 10)])
    await engine.settled()

    expect(engine.status().index).toBe(1)
    expect(engine.status().track?.path).toBe('a.mp3')
    expect(engine.state).toBe('playing')
    expect(engine.position()).toBeCloseTo(3, 5)
  })

  it('resets when the playing track is gone from the new queue', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    engine.setQueue([track('z.mp3', 10)])

    expect(engine.status().index).toBe(-1)
    expect(engine.state).toBe('idle')
  })

  it('notifies subscribers and returns an unsubscribe function', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    const seen: string[] = []
    const unsubscribe = engine.subscribe((status) => seen.push(status.state))

    expect(seen).toEqual(['idle'])
    await engine.play()
    expect(seen).toContain('playing')

    unsubscribe()
    await engine.pause()
    expect(seen).not.toContain('paused')
  })

  it('applies volume changes to the graph', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    engine.setVolume(0.5)

    expect(factory.current.lastVolume).toBe(0.5)
    expect(engine.status().volume).toBe(0.5)
  })

  it('clamps volume into range', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    engine.setVolume(5)
    expect(engine.status().volume).toBe(1)

    engine.setVolume(-2)
    expect(engine.status().volume).toBe(0)
  })

  it('closes the graph on dispose', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    await engine.dispose()

    expect(factory.current.closeCount).toBe(1)
    expect(engine.state).toBe('idle')
    expect(engine.status().queueLength).toBe(0)
  })

  it('reports the eq curve in status and applies updates', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])

    expect(engine.status().eq.bandGainsDb).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])

    engine.setEq({ ...engine.eq, bandGainsDb: [3, 0, 0, 0, 0, 0, 0, 0, 0, -3] })

    expect(engine.status().eq.bandGainsDb[0]).toBe(3)
    expect(engine.status().eq.bandGainsDb[9]).toBe(-3)
  })

  it('keeps the reported curve in sync with the volume control', async () => {
    const { engine } = makeEngine()

    engine.setVolume(0.5)

    expect(engine.status().eq.masterVolume).toBe(0.5)
  })

  it('refreshes queued metadata without interrupting playback', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    factory.current.advance(4)

    engine.refreshTracks([
      track('a.mp3', 10, 'Retitled A'),
      track('b.mp3', 10, 'Retitled B')
    ])
    await engine.settled()

    expect(engine.status().index).toBe(0)
    expect(engine.status().track?.title).toBe('Retitled A')
    expect(engine.state).toBe('playing')
    expect(engine.position()).toBeCloseTo(4, 5)
  })

  it('keeps queued entries that vanish from the fresh list', async () => {
    const { engine } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()

    engine.refreshTracks([track('b.mp3', 10, 'Retitled B')])

    expect(engine.status().queue.map((t) => t.title)).toEqual(['a.mp3', 'Retitled B'])
    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('playing')
  })

  it('inserts tracks to play next without interrupting the current one', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    factory.current.advance(2)

    engine.addNext([track('c.mp3', 10)])

    expect(engine.status().queue.map((t) => t.path)).toEqual(['a.mp3', 'c.mp3', 'b.mp3'])
    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('playing')
    expect(engine.position()).toBeCloseTo(2, 5)
  })

  it('appends tracks to the end of the queue without touching playback', async () => {
    const { engine } = makeEngine([track('a.mp3', 10)])
    await engine.play()

    engine.addLast([track('b.mp3', 10), track('c.mp3', 10)])

    expect(engine.status().queue.map((t) => t.path)).toEqual(['a.mp3', 'b.mp3', 'c.mp3'])
    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('playing')
  })

  it('queues into an empty engine without starting playback', async () => {
    const { engine } = makeEngine()

    engine.addNext([track('a.mp3', 10)])
    expect(engine.status().queueLength).toBe(1)
    expect(engine.state).toBe('idle')

    await engine.play()
    expect(engine.status().track?.path).toBe('a.mp3')
  })

  it('removing an upcoming track keeps the current one playing', async () => {
    const { engine, factory } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    factory.current.advance(1)

    engine.removeAt(1)

    expect(engine.status().queue.map((t) => t.path)).toEqual(['a.mp3'])
    expect(engine.state).toBe('playing')
    expect(engine.position()).toBeCloseTo(1, 5)
  })

  it('removing the playing track advances onto the next one', async () => {
    const { engine } = makeEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()

    engine.removeAt(0)
    await engine.settled()

    expect(engine.status().queue.map((t) => t.path)).toEqual(['b.mp3'])
    expect(engine.status().index).toBe(0)
    expect(engine.state).toBe('playing')
  })
})
