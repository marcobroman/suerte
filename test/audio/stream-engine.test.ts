import { describe, expect, it, vi } from 'vitest'
import type { Track } from '@shared/types'
import type { MediaElementLike } from '@/audio/graph'
import { StreamEngine } from '@/audio/stream-engine'
import { GraphFactory } from './fake-graph'

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

class FakeAudioElement implements MediaElementLike {
  src = ''
  currentTime = 0
  duration = Number.NaN
  readyState = 4
  playCalls = 0
  pauseCalls = 0
  playError: Error | null = null
  readonly #listeners = new Map<string, Set<() => void>>()

  async play(): Promise<void> {
    this.playCalls += 1
    if (this.playError) throw this.playError
  }

  pause(): void {
    this.pauseCalls += 1
  }

  addEventListener(type: 'ended' | 'error' | 'loadedmetadata', listener: () => void): void {
    const set = this.#listeners.get(type) ?? new Set<() => void>()
    set.add(listener)
    this.#listeners.set(type, set)
  }

  removeEventListener(type: 'ended' | 'error' | 'loadedmetadata', listener: () => void): void {
    this.#listeners.get(type)?.delete(listener)
  }

  emit(type: 'ended' | 'error' | 'loadedmetadata'): void {
    for (const listener of this.#listeners.get(type) ?? []) listener()
  }

  /** Simulates the track playing out to its end. */
  finish(): void {
    this.emit('ended')
  }
}

function makeStreamEngine(queue: readonly Track[] = []) {
  const factory = new GraphFactory()
  const element = new FakeAudioElement()
  const streamUrl = vi.fn((path: string) => `https://phone/stream?path=${encodeURIComponent(path)}`)
  const engine = new StreamEngine({
    createGraph: factory.create,
    createAudio: () => element,
    streamUrl
  })
  if (queue.length > 0) engine.setQueue(queue)
  return { engine, factory, element, streamUrl }
}

describe('StreamEngine', () => {
  it('starts idle with an empty queue', () => {
    const { engine } = makeStreamEngine()
    const status = engine.status()

    expect(status.state).toBe('idle')
    expect(status.index).toBe(-1)
    expect(status.queueLength).toBe(0)
    expect(status.repeat).toBe('off')
    expect(status.shuffle).toBe(false)
  })

  it('points the element at the stream URL on play', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])

    await engine.play()

    expect(element.src).toBe('https://phone/stream?path=a.mp3')
    expect(element.playCalls).toBe(1)
    expect(engine.state).toBe('playing')
    expect(engine.status().track?.path).toBe('a.mp3')
  })

  it('pauses and resumes without reloading the source', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])
    await engine.play()
    element.currentTime = 5

    engine.pause()
    expect(engine.state).toBe('paused')
    expect(engine.position()).toBe(5)

    await engine.play()
    expect(element.playCalls).toBe(2)
    expect(element.src).toBe('https://phone/stream?path=a.mp3')
    expect(engine.state).toBe('playing')
  })

  it('advances when the element ends and stops at the end of the queue', async () => {
    const onQueueEnd = vi.fn()
    const factory = new GraphFactory()
    const element = new FakeAudioElement()
    const engine = new StreamEngine({
      createGraph: factory.create,
      createAudio: () => element,
      streamUrl: (path) => `https://phone/${path}`,
      onQueueEnd
    })
    engine.setQueue([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()

    element.finish()
    await engine.settled()
    expect(engine.status().index).toBe(1)

    element.finish()
    await engine.settled()
    expect(engine.state).toBe('paused')
    expect(onQueueEnd).toHaveBeenCalledOnce()
  })

  it('ignores a stale ended event after pausing', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])
    await engine.play()
    engine.pause()

    element.finish()
    await engine.settled()

    expect(engine.state).toBe('paused')
    expect(engine.status().index).toBe(0)
  })

  it('repeats one and wraps on repeat all', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10), track('b.mp3', 10)])
    engine.setRepeat('one')
    await engine.play()

    element.finish()
    await engine.settled()
    expect(engine.status().index).toBe(0)
    expect(element.playCalls).toBe(2)

    engine.setRepeat('all')
    await engine.playAt(1)
    element.finish()
    await engine.settled()
    expect(engine.status().index).toBe(0)
    expect(engine.status().track?.path).toBe('a.mp3')
  })

  it('wraps the next button on repeat all only', async () => {
    const { engine } = makeStreamEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.playAt(1)
    await engine.next()
    expect(engine.status().index).toBe(1)

    engine.setRepeat('all')
    await engine.next()
    expect(engine.status().index).toBe(0)
  })

  it('cycles repeat modes and ignores unknown ones', () => {
    const { engine } = makeStreamEngine()

    engine.cycleRepeat()
    expect(engine.status().repeat).toBe('all')
    engine.cycleRepeat()
    expect(engine.status().repeat).toBe('one')
    engine.cycleRepeat()
    expect(engine.status().repeat).toBe('off')
    engine.setRepeat('sometimes' as never)
    expect(engine.status().repeat).toBe('off')
  })

  it('shuffles with the current track first and restores on toggle off', async () => {
    const paths = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3']
    const { engine } = makeStreamEngine(paths.map((path) => track(path, 10)))
    await engine.play()
    await engine.next()

    engine.setShuffle(true)

    expect(engine.status().shuffle).toBe(true)
    expect(engine.status().index).toBe(0)
    expect(engine.status().track?.path).toBe('b.mp3')
    expect([...engine.status().queue.map((t) => t.path)].sort()).toEqual([...paths].sort())

    engine.setShuffle(false)

    expect(engine.status().queue.map((t) => t.path)).toEqual(paths)
    expect(engine.status().index).toBe(1)
    expect(engine.state).toBe('playing')
  })

  it('seeks through the element and defers seeks before metadata', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])
    await engine.play()

    await engine.seek(4)
    expect(element.currentTime).toBe(4)
    expect(engine.position()).toBe(4)

    element.readyState = 0
    await engine.seek(7)
    expect(engine.position()).toBe(7)
    element.readyState = 4
    element.duration = 10
    element.emit('loadedmetadata')
    expect(element.currentTime).toBe(7)
  })

  it('reports playback failures as errors', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])
    element.playError = new Error('not allowed')

    await engine.play()

    expect(engine.state).toBe('error')
    expect(engine.status().error).toBe('not allowed')
  })

  it('reports element errors while playing', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10)])
    await engine.play()

    element.emit('error')

    expect(engine.state).toBe('error')
  })

  it('attaches the element to the EQ chain exactly once', async () => {
    const { engine, factory } = makeStreamEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()
    await engine.next()

    expect(factory.graphs).toHaveLength(1)
    expect(factory.current.mediaAttachments).toBe(1)
  })

  it('removes the playing track onto the next one', async () => {
    const { engine, element } = makeStreamEngine([track('a.mp3', 10), track('b.mp3', 10)])
    await engine.play()

    engine.removeAt(0)
    await engine.settled()

    expect(engine.status().queue.map((t) => t.path)).toEqual(['b.mp3'])
    expect(engine.status().index).toBe(0)
    expect(element.src).toBe('https://phone/stream?path=b.mp3')
  })

  it('notifies subscribers and unsubscribes', async () => {
    const { engine } = makeStreamEngine([track('a.mp3', 10)])
    const seen: string[] = []
    const unsubscribe = engine.subscribe((status) => seen.push(status.state))

    expect(seen).toEqual(['idle'])
    await engine.play()
    expect(seen).toContain('playing')

    unsubscribe()
    engine.pause()
    expect(seen).not.toContain('paused')
  })
})
