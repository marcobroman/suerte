import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONFIG_FILE,
  CONFIG_VERSION,
  configPath,
  EMPTY_CONFIG,
  loadConfig,
  normalizeRoots,
  saveConfig
} from '@main/config'
import { DEFAULT_SERVER_PORT, DEFAULT_THEME } from '@shared/types'

describe('normalizeRoots', () => {
  it('keeps order and trims whitespace', () => {
    expect(normalizeRoots([' /b ', '/a '])).toEqual(['/b', '/a'])
  })

  it('drops non-strings and blanks', () => {
    expect(normalizeRoots(['/a', '', '   ', 7, null, {}, '/b'])).toEqual(['/a', '/b'])
  })

  it('removes duplicates, keeping the first occurrence', () => {
    expect(normalizeRoots(['/a', '/b', '/a'])).toEqual(['/a', '/b'])
  })

  it('returns nothing for non-arrays', () => {
    expect(normalizeRoots('/a')).toEqual([])
    expect(normalizeRoots(null)).toEqual([])
    expect(normalizeRoots(undefined)).toEqual([])
  })
})

describe('config', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads back what was saved', async () => {
    await saveConfig(dir, { roots: ['/music', '/more'] })

    expect(await loadConfig(dir)).toEqual({ version: CONFIG_VERSION, roots: ['/music', '/more'], theme: DEFAULT_THEME })
  })

  it('creates the directory when it is missing', async () => {
    const nested = join(dir, 'deeper')
    await saveConfig(nested, { roots: ['/music'] })

    expect(await loadConfig(nested)).toEqual({ version: CONFIG_VERSION, roots: ['/music'], theme: DEFAULT_THEME })
  })

  it('overwrites an existing config without leaving a temp file', async () => {
    await saveConfig(dir, { roots: ['/first'] })
    await saveConfig(dir, { roots: ['/second'] })

    expect(await loadConfig(dir)).toEqual({ version: CONFIG_VERSION, roots: ['/second'], theme: DEFAULT_THEME })
    await expect(readFile(`${configPath(dir)}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('writes human-readable json ending in a newline', async () => {
    await saveConfig(dir, { roots: ['/music'] })

    const raw = await readFile(configPath(dir), 'utf8')
    expect(raw).toContain('\n  "roots"')
    expect(raw.endsWith('}\n')).toBe(true)
  })

  it('treats a missing file as an empty config', async () => {
    expect(await loadConfig(dir)).toEqual(EMPTY_CONFIG)
  })

  it('falls back to an empty config when the file is corrupt', async () => {
    await writeFile(configPath(dir), '{ not json', 'utf8')

    expect(await loadConfig(dir)).toEqual(EMPTY_CONFIG)
  })

  it('falls back to an empty config when the json is not an object', async () => {
    await writeFile(configPath(dir), '"nope"', 'utf8')

    expect(await loadConfig(dir)).toEqual(EMPTY_CONFIG)
  })

  it('ignores a malformed roots list', async () => {
    await writeFile(configPath(dir), JSON.stringify({ version: 1, roots: ['/a', 3], theme: DEFAULT_THEME }), 'utf8')

    expect((await loadConfig(dir)).roots).toEqual(['/a'])
  })

  it('tolerates unknown extra fields', async () => {
    await writeFile(
      configPath(dir),
      JSON.stringify({ version: 99, roots: ['/a'], future: { thing: true } }),
      'utf8'
    )

    expect(await loadConfig(dir)).toEqual({ version: CONFIG_VERSION, roots: ['/a'], theme: DEFAULT_THEME })
  })

  it('reads a file that a Windows editor saved with a byte-order mark', async () => {
    await writeFile(configPath(dir), `\uFEFF${JSON.stringify({ version: 1, roots: ['/a'], theme: DEFAULT_THEME })}`, 'utf8')

    expect((await loadConfig(dir)).roots).toEqual(['/a'])
  })

  it('tolerates a missing roots field', async () => {
    await writeFile(configPath(dir), JSON.stringify({ version: 1 }), 'utf8')

    expect(await loadConfig(dir)).toEqual(EMPTY_CONFIG)
  })

  it('stores nothing for an empty folder list', async () => {
    await saveConfig(dir, { roots: [] })

    expect((await loadConfig(dir)).roots).toEqual([])
  })

  it('uses a stable file name', () => {
    expect(configPath(dir)).toBe(join(dir, CONFIG_FILE))
  })

  it('defaults to the default theme when none was saved', async () => {
    expect((await loadConfig(dir)).theme).toBe(DEFAULT_THEME)
  })

  it('round-trips a chosen theme', async () => {
    await saveConfig(dir, { roots: ['/music'], theme: 'ember' })
    expect((await loadConfig(dir)).theme).toBe('ember')
  })

  it('round-trips a discogs token', async () => {
    await saveConfig(dir, { roots: ['/music'], discogsToken: 'abc123' })

    expect((await loadConfig(dir)).discogsToken).toBe('abc123')
  })

  it('trims a pasted token and drops blanks or non-strings', async () => {
    await saveConfig(dir, { roots: [], discogsToken: '  abc123  ' })
    expect((await loadConfig(dir)).discogsToken).toBe('abc123')

    await saveConfig(dir, { roots: [] })
    expect((await loadConfig(dir)).discogsToken).toBeUndefined()

    await writeFile(configPath(dir), JSON.stringify({ version: 1, roots: [], discogsToken: 7 }), 'utf8')
    expect((await loadConfig(dir)).discogsToken).toBeUndefined()
  })

  it('omits the token key when none is stored', async () => {
    await saveConfig(dir, { roots: ['/music'] })

    expect(await readFile(configPath(dir), 'utf8')).not.toContain('discogsToken')
  })

  it('round-trips a server section', async () => {
    await saveConfig(dir, {
      roots: ['/music'],
      server: { enabled: true, port: 5000, token: 's3cret', sessions: [], devices: [] }
    })

    expect((await loadConfig(dir)).server).toEqual({
      enabled: true,
      port: 5000,
      token: 's3cret',
      sessions: [],
      devices: []
    })
  })

  it('round-trips server sessions and drops malformed ones', async () => {
    await saveConfig(dir, {
      roots: ['/music'],
      server: {
        enabled: true,
        port: 5000,
        token: 's3cret',
        sessions: [{ id: 'a1', createdAt: 123 }],
        devices: [{ token: 'd1', name: 'Phone', createdAt: 10, lastSeen: 20 }]
      }
    })
    expect((await loadConfig(dir)).server?.sessions).toEqual([{ id: 'a1', createdAt: 123 }])
    expect((await loadConfig(dir)).server?.devices).toEqual([
      { token: 'd1', name: 'Phone', createdAt: 10, lastSeen: 20 }
    ])

    await writeFile(
      configPath(dir),
      JSON.stringify({
        version: 1,
        roots: [],
        server: {
          enabled: false,
          port: 5000,
          sessions: [
            { id: 'ok', createdAt: 7 },
            { id: '', createdAt: 7 },
            { id: 'ok', createdAt: 8 },
            { id: 'nocreated' },
            'garbage',
            null
          ]
        }
      }),
      'utf8'
    )
    expect((await loadConfig(dir)).server?.sessions).toEqual([{ id: 'ok', createdAt: 7 }])
  })

  it('round-trips devices and drops malformed ones', async () => {
    await writeFile(
      configPath(dir),
      JSON.stringify({
        version: 1,
        roots: [],
        server: {
          enabled: false,
          port: 5000,
          devices: [
            { token: 'good', name: 'Phone', createdAt: 7, lastSeen: 9 },
            { token: '', name: 'Blank', createdAt: 7, lastSeen: 9 },
            { token: 'good', name: 'Dupe', createdAt: 7, lastSeen: 9 },
            { token: 'noname', createdAt: 7, lastSeen: 9 },
            { token: 'badtimestamps', name: 'X', createdAt: 'now', lastSeen: 9 },
            'garbage',
            null
          ]
        }
      }),
      'utf8'
    )
    expect((await loadConfig(dir)).server?.devices).toEqual([
      { token: 'good', name: 'Phone', createdAt: 7, lastSeen: 9 },
      { token: 'noname', name: 'Phone', createdAt: 7, lastSeen: 9 }
    ])
  })

  it('keeps the token but falls back to the default port when malformed', async () => {
    await writeFile(
      configPath(dir),
      JSON.stringify({ version: 1, roots: [], server: { enabled: true, port: 80, token: 's3cret' } }),
      'utf8'
    )

    expect((await loadConfig(dir)).server).toEqual({
      enabled: true,
      port: DEFAULT_SERVER_PORT,
      token: 's3cret',
      sessions: [],
      devices: []
    })

    await writeFile(configPath(dir), JSON.stringify({ version: 1, roots: [] }), 'utf8')
    expect((await loadConfig(dir)).server).toBeUndefined()
  })

  it('round-trips a saved eq curve', async () => {
    const eq = {
      bandGainsDb: [1, 2, 3, 4, 5, 4, 3, 2, 1, 0],
      preampDb: -2,
      autoPreamp: false,
      bassDb: 3,
      trebleDb: -1
    }
    await saveConfig(dir, { roots: ['/music'], eq })

    expect((await loadConfig(dir)).eq).toEqual(eq)
  })

  it('drops malformed eq curves instead of half-applying them', async () => {
    await saveConfig(dir, { roots: [] })
    expect((await loadConfig(dir)).eq).toBeUndefined()

    await writeFile(
      configPath(dir),
      JSON.stringify({ version: 1, roots: [], eq: { bandGainsDb: [1, 2], preampDb: 0, autoPreamp: true, bassDb: 0, trebleDb: 0 } }),
      'utf8'
    )
    expect((await loadConfig(dir)).eq).toBeUndefined()

    await writeFile(
      configPath(dir),
      JSON.stringify({ version: 1, roots: [], eq: { bandGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 'x'], preampDb: 0, autoPreamp: true, bassDb: 0, trebleDb: 0 } }),
      'utf8'
    )
    expect((await loadConfig(dir)).eq).toBeUndefined()
  })

  it('keeps the theme when only roots change', async () => {
    await saveConfig(dir, { roots: ['/a'], theme: 'midnight' })
    await saveConfig(dir, { roots: ['/a', '/b'], theme: 'midnight' })

    expect((await loadConfig(dir))).toEqual({ version: 1, roots: ['/a', '/b'], theme: 'midnight' })
  })

  it('falls back to the default for an unknown theme', async () => {
    await writeFile(configPath(dir), JSON.stringify({ version: 1, roots: [], theme: 'neon' }), 'utf8')

    expect((await loadConfig(dir)).theme).toBe(DEFAULT_THEME)
  })

  it('falls back to the default when the theme is not a string', async () => {
    await writeFile(configPath(dir), JSON.stringify({ version: 1, theme: 5 }), 'utf8')

    expect((await loadConfig(dir)).theme).toBe(DEFAULT_THEME)
  })

  it('still restores roots from a config written before themes existed', async () => {
    await writeFile(configPath(dir), JSON.stringify({ version: 1, roots: ['/legacy'], theme: DEFAULT_THEME }), 'utf8')

    expect(await loadConfig(dir)).toEqual({
      version: CONFIG_VERSION,
      roots: ['/legacy'],
      theme: DEFAULT_THEME
    })
  })
})
