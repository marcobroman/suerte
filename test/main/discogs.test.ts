import { describe, expect, it, vi } from 'vitest'
import { DiscogsError, createDiscogsClient } from '@main/discogs'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: unknown) => handler(String(input)))
}

const SEARCH_PAGE = {
  results: [
    {
      id: 111,
      type: 'master',
      title: 'Aurora – Dawn',
      year: '2001',
      label: ['Northern Records'],
      thumb: 'https://i.discogs.com/thumb1.jpg'
    },
    {
      id: 222,
      type: 'release',
      title: 'Basalt – Dawn',
      year: 2005,
      label: ['Stone Tapes'],
      cover_image: 'https://i.discogs.com/thumb2.jpg'
    },
    { id: 333, type: 'artist', title: 'Someone' },
    { id: 'bad', type: 'master', title: 'Broken' },
    { id: 444, type: 'master', title: '   ' }
  ]
}

const MASTER_DETAIL = {
  id: 111,
  artists: [{ name: 'Aurora (2)' }, { name: 'Guest' }],
  title: 'Dawn',
  year: '2001',
  labels: [{ name: 'Northern Records' }],
  tracklist: [
    { position: '', type_: 'heading', title: 'Side A' },
    { position: 'A1', title: 'One', duration: '3:12' },
    { position: 'A2', title: '  ', duration: '' },
    { position: 'B1', title: 'Two', duration: '' }
  ],
  images: [
    { type: 'secondary', uri: 'https://i.discogs.com/second.jpg' },
    { type: 'primary', uri: 'https://i.discogs.com/primary.jpg' }
  ]
}

describe('createDiscogsClient', () => {
  it('refuses a blank token before any request', () => {
    expect(() => createDiscogsClient({ token: '  ' })).toThrowError(DiscogsError)
    try {
      createDiscogsClient({ token: '' })
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as DiscogsError).kind).toBe('missing-token')
    }
  })

  it('maps search hits, splitting combined titles', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(SEARCH_PAGE))
    const client = createDiscogsClient({ token: 't', throttleMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })

    const found = await client.searchReleases('dawn')

    expect(found).toEqual([
      {
        id: 111,
        kind: 'master',
        title: 'Dawn',
        artist: 'Aurora',
        year: 2001,
        label: 'Northern Records',
        thumbUrl: 'https://i.discogs.com/thumb1.jpg'
      },
      {
        id: 222,
        kind: 'release',
        title: 'Dawn',
        artist: 'Basalt',
        year: 2005,
        label: 'Stone Tapes',
        thumbUrl: 'https://i.discogs.com/thumb2.jpg'
      }
    ])
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('api.discogs.com/database/search')
  })

  it('never queries on a blank search', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(SEARCH_PAGE))
    const client = createDiscogsClient({ token: 't', throttleMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(await client.searchReleases('   ')).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps 401, 429 and transport failures to kinds', async () => {
    const refused = createDiscogsClient({
      token: 'bad',
      throttleMs: 0,
      fetchImpl: stubFetch(() => jsonResponse({}, 401)) as unknown as typeof fetch
    })
    await expect(refused.searchReleases('x')).rejects.toMatchObject({ kind: 'unauthorized' })

    const limited = createDiscogsClient({
      token: 't',
      throttleMs: 0,
      fetchImpl: stubFetch(() => jsonResponse({}, 429)) as unknown as typeof fetch
    })
    await expect(limited.searchReleases('x')).rejects.toMatchObject({ kind: 'rate-limited' })

    const offline = createDiscogsClient({
      token: 't',
      throttleMs: 0,
      fetchImpl: stubFetch(() => {
        throw new Error('boom')
      }) as unknown as typeof fetch
    })
    await expect(offline.searchReleases('x')).rejects.toMatchObject({ kind: 'network' })
  })

  it('maps a release with plain artist names and skips headings', async () => {
    const fetchImpl = stubFetch(() => jsonResponse(MASTER_DETAIL))
    const client = createDiscogsClient({ token: 't', throttleMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })

    const release = await client.getRelease(111, 'master')

    expect(release).toEqual({
      id: 111,
      kind: 'master',
      artist: 'Aurora, Guest',
      title: 'Dawn',
      year: 2001,
      label: 'Northern Records',
      tracks: [
        { position: 'A1', title: 'One', duration: '3:12' },
        { position: 'B1', title: 'Two', duration: '' }
      ],
      coverUrl: 'https://i.discogs.com/primary.jpg'
    })
  })

  it('maps a missing release to not-found', async () => {
    const fetchImpl = stubFetch(() => jsonResponse({}, 404))
    const client = createDiscogsClient({ token: 't', throttleMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(client.getRelease(9, 'release')).rejects.toMatchObject({ kind: 'not-found' })
  })

  it('downloads art only from discogs image hosts', async () => {
    const bytes = new Response('fake-bytes', { headers: { 'content-type': 'image/jpeg' } })
    const fetchImpl = stubFetch((url: string) => {
      expect(url).toBe('https://i.discogs.com/primary.jpg')
      return bytes
    })
    const client = createDiscogsClient({ token: 't', throttleMs: 0, fetchImpl: fetchImpl as unknown as typeof fetch })

    const art = await client.fetchArt('https://i.discogs.com/primary.jpg')
    expect(art.mime).toBe('image/jpeg')
    expect(art.data.length).toBeGreaterThan(0)

    await expect(client.fetchArt('https://evil.example/x.jpg')).rejects.toMatchObject({
      kind: 'network'
    })
    const html = createDiscogsClient({
      token: 't',
      throttleMs: 0,
      fetchImpl: stubFetch(
        () => new Response('<html>', { headers: { 'content-type': 'text/html' } })
      ) as unknown as typeof fetch
    })
    await expect(html.fetchArt('https://i.discogs.com/x.jpg')).rejects.toMatchObject({
      kind: 'network'
    })
  })
})
