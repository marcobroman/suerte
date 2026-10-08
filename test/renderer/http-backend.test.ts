import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HttpBackend,
  describeServerUrl,
  exchangePairingCode,
  loadServerCredentials,
  pairFromHash,
  phoneEntryUrl,
  phonePairUrl,
  saveServerCredentials,
  tokenFromHash,
  type KeyValueStorage
} from '@/http-backend'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  onmessage: ((event: { data: string }) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  emit(data: string): void {
    this.onmessage?.({ data })
  }
}

function stubStorage(): { store: Map<string, string>; storage: KeyValueStorage } {
  const store = new Map<string, string>()
  return {
    store,
    storage: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, String(value))
      }
    }
  }
}

let storage: KeyValueStorage

function makeBackend(): HttpBackend {
  return new HttpBackend('https://phone:4280/', 'tok', storage)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('HttpBackend', () => {
  beforeEach(() => {
    storage = stubStorage().storage
    FakeEventSource.instances = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logs in once, then calls the API without URL tokens', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: { headers?: Record<string, string> }): Promise<Response> =>
        jsonResponse({
          trackCount: 3,
          tree: { artists: [], albums: [] },
          tracks: [],
          scanning: false
        })
    )
    vi.stubGlobal('fetch', fetchImpl)
    const backend = new HttpBackend('https://phone:4280/', 'tok', storage)

    const library = await backend.getLibrary()

    expect(library).toMatchObject({ trackCount: 3 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const sessionCall = fetchImpl.mock.calls[0]
    const apiCall = fetchImpl.mock.calls[1]
    // The handshake carries the token in a header, never the URL.
    expect(sessionCall?.[0]).toBe('https://phone:4280/api/session')
    expect(sessionCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer tok' }
    })
    // From then on the cookie authenticates: no token in the URL.
    expect(apiCall?.[0]).toBe('https://phone:4280/api/library')
    expect(apiCall?.[1]).toMatchObject({ headers: { Authorization: 'Bearer tok' } })

    // A second API call reuses the session — no new handshake.
    await backend.getLibrary()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('https://phone:4280/api/library')
  })

  it('shares one session handshake across concurrent calls', async () => {
    let posts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/api/session')) posts += 1
        return jsonResponse({})
      })
    )
    const backend = makeBackend()

    await Promise.all([backend.startSession(), backend.startSession()])

    expect(posts).toBe(1)
  })

  it('fails loudly when login is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'x' }, 401)))
    const backend = makeBackend()

    await expect(backend.startSession()).rejects.toThrow('401')
    // No silent fallback to tokens in URLs: the API call never goes out.
    await expect(backend.getLibrary()).rejects.toThrow('401')
  })

  it('drops tokens from media and event URLs once logged in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const backend = makeBackend()

    // Before login the query token keeps media working (server accepts both).
    expect(backend.streamUrl('abc')).toBe('https://phone:4280/api/stream?id=abc&token=tok')

    await backend.startSession()

    expect(backend.streamUrl('abc')).toBe('https://phone:4280/api/stream?id=abc')
    expect(await backend.readCover('abc')).toBe('https://phone:4280/api/cover?id=abc')
    vi.stubGlobal('EventSource', FakeEventSource)
    backend.onLibraryChanged(() => {})
    expect(FakeEventSource.instances[0]?.url).toBe('https://phone:4280/api/events')
  })

  it('throws on failed requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'x' }, 403)))
    const backend = makeBackend()

    await expect(backend.getLibrary()).rejects.toThrow('403')
  })

  it('builds same-origin cover URLs without fetching', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    vi.stubGlobal('fetch', fetchImpl)
    const backend = makeBackend()

    const url = await backend.readCover('C:\\music\\a b.mp3')

    // Opaque id in, same-origin URL out — the value is passed through untouched.
    expect(url).toBe('https://phone:4280/api/cover?id=C%3A%5Cmusic%5Ca+b.mp3&token=tok')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads file bytes for compatibility', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200 }))
    )
    const backend = makeBackend()

    expect(new Uint8Array(await backend.readFile('a.mp3'))).toEqual(bytes)
  })

  it('subscribes to library changes over SSE and unsubscribes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    vi.stubGlobal('EventSource', FakeEventSource)
    const backend = makeBackend()
    const seen: unknown[] = []

    const unsubscribe = backend.onLibraryChanged((summary) => {
      seen.push(summary)
    })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe(
      'https://phone:4280/api/events?token=tok'
    )

    FakeEventSource.instances[0]?.emit('{"trackCount":5,"scanning":false}')
    FakeEventSource.instances[0]?.emit('not json{{{')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ trackCount: 5, roots: [], missingRoots: [] })

    unsubscribe()
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('keeps theme and EQ per device in local storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    const backend = makeBackend()

    expect((await backend.getSettings()).theme).toBe('spotlight')
    await backend.setTheme('midnight')
    expect((await backend.getSettings()).theme).toBe('midnight')
    await backend.setTheme('neon')
    expect((await backend.getSettings()).theme).toBe('midnight')

    await backend.setEqSettings({
      bandGainsDb: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      preampDb: 0,
      autoPreamp: true,
      bassDb: 0,
      trebleDb: 0
    })
    expect((await backend.getSettings()).eq).toMatchObject({ preampDb: 0 })
    expect((await backend.getSettings()).server).toMatchObject({
      enabled: true,
      tokenSet: true,
      url: 'https://phone:4280',
      urls: ['https://phone:4280'],
      secure: true,
      fingerprint: null
    })
  })

  it('rejects desktop-only operations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    const backend = makeBackend()

    await expect(backend.pickFolders()).rejects.toThrow(/desktop/i)
    await expect(backend.scanLibrary()).rejects.toThrow(/desktop/i)
    await expect(backend.updateTags([])).rejects.toThrow(/desktop/i)
    await expect(backend.searchDiscogs()).rejects.toThrow(/desktop/i)
    await expect(backend.setServerEnabled()).rejects.toThrow(/desktop/i)
    await expect(backend.getServerToken()).rejects.toThrow(/desktop/i)
  })
})

describe('phoneEntryUrl', () => {
  it('carries the token in the fragment, never the query', () => {
    const url = phoneEntryUrl('https://phone:4280/', 't o/k&en')

    expect(url.startsWith('https://phone:4280/')).toBe(true)
    expect(url).not.toContain('?token=')
    expect(url).toContain('#t=')
  })
})

describe('tokenFromHash', () => {
  it('reads the token back out', () => {
    expect(tokenFromHash('#t=abc123')).toBe('abc123')
    expect(tokenFromHash('#t=a%20b')).toBe('a b')
  })

  it('rejects empties and garbage', () => {
    expect(tokenFromHash('')).toBeNull()
    expect(tokenFromHash('#t=')).toBeNull()
    expect(tokenFromHash('#other=1')).toBeNull()
    expect(tokenFromHash('#t=%ZZ')).toBeNull()
  })
})

describe('phonePairUrl', () => {
  it('carries the pairing code in the fragment, never the query', () => {
    const url = phonePairUrl('https://phone:4280/', 'AB3DF9K2Q')

    expect(url.startsWith('https://phone:4280/')).toBe(true)
    expect(url).not.toContain('?token=')
    expect(url).toContain('#pair=')
  })
})

describe('pairFromHash', () => {
  it('reads the pairing code back out', () => {
    expect(pairFromHash('#pair=AB3DF9K2Q')).toBe('AB3DF9K2Q')
    expect(pairFromHash('#t=abc&pair=XYZ')).toBe('XYZ')
  })

  it('rejects empties and garbage', () => {
    expect(pairFromHash('')).toBeNull()
    expect(pairFromHash('#pair=')).toBeNull()
    expect(pairFromHash('#t=abc')).toBeNull()
    expect(pairFromHash('#pair=%ZZ')).toBeNull()
  })
})

describe('describeServerUrl', () => {
  it('recognizes the tailnet range', () => {
    expect(describeServerUrl('https://100.64.0.5:4280')).toBe('tailscale')
    expect(describeServerUrl('http://100.127.255.1:4280')).toBe('tailscale')
  })

  it('treats everything else as home LAN', () => {
    expect(describeServerUrl('http://192.168.1.5:4280')).toBe('lan')
    expect(describeServerUrl('http://10.0.0.2:4280')).toBe('lan')
    // Just outside the tailnet range on both sides.
    expect(describeServerUrl('http://100.63.0.1:4280')).toBe('lan')
    expect(describeServerUrl('http://100.128.0.1:4280')).toBe('lan')
    expect(describeServerUrl('not a url')).toBe('lan')
    expect(describeServerUrl('https://[::1]:4280')).toBe('lan')
  })
})

describe('exchangePairingCode', () => {
  it('posts the code and name, returning the device token', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(url).toBe('https://phone:4280/api/pair')
      expect(JSON.parse(String(init?.body))).toEqual({ code: 'AB3DF9K2Q', name: 'Phone' })
      return jsonResponse({ token: 'device-token' })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const token = await exchangePairingCode('https://phone:4280/', 'AB3DF9K2Q', '  Phone  ')

    expect(token).toBe('device-token')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('explains expired codes and rejects blank names locally', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)))

    await expect(exchangePairingCode('https://phone:4280', 'USED', 'Phone')).rejects.toThrow(
      /fresh one/
    )
    await expect(exchangePairingCode('https://phone:4280', 'CODE', '   ')).rejects.toThrow(
      /device/i
    )
  })

  it('rejects malformed server answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))

    await expect(exchangePairingCode('https://phone:4280', 'CODE', 'Phone')).rejects.toThrow(
      /without a token/
    )
  })
})

describe('server credentials', () => {
  it('round-trips through storage', () => {
    const { storage } = stubStorage()

    expect(loadServerCredentials(storage)).toBeNull()
    saveServerCredentials(storage, { baseUrl: 'https://phone:4280', token: 'tok' })
    expect(loadServerCredentials(storage)).toEqual({ baseUrl: 'https://phone:4280', token: 'tok' })
  })

  it('drops blanks and malformed entries', () => {
    const { store, storage } = stubStorage()

    store.set('onda.phone.server', JSON.stringify({ baseUrl: '', token: 'tok' }))
    expect(loadServerCredentials(storage)).toBeNull()
    store.set('onda.phone.server', 'not json{{{')
    expect(loadServerCredentials(storage)).toBeNull()
    store.set('onda.phone.server', JSON.stringify({ baseUrl: 7 }))
    expect(loadServerCredentials(storage)).toBeNull()
  })
})
