import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import type { SecretBox } from '@main/secrets'
import { DEFAULT_SERVER_PORT, DEFAULT_THEME } from '@shared/types'

/** Stand-in vault: base64 envelopes instead of OS encryption. */
const envelopeBox: SecretBox = {
  available: () => true,
  protect: (plaintext) => ({ enc: Buffer.from(plaintext, 'utf8').toString('base64') }),
  unprotect: (value) => {
    if (typeof value === 'string') return value
    return Buffer.from(value.enc, 'base64').toString('utf8')
  }
}

/** Locked vault: everything secret fails, nothing is readable or writable. */
const lockedBox: SecretBox = {
  available: () => false,
  protect: () => {
    throw new Error('vault locked')
  },
  unprotect: () => {
    throw new Error('vault locked')
  }
}

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

  it.runIf(process.platform !== 'win32')('locks the config file to owner-only', async () => {
    await saveConfig(dir, { roots: ['/music'] })

    const { mode } = await stat(configPath(dir))
    expect(mode & 0o777).toBe(0o600)
  })

  it('round-trips a server section', async () => {
    await saveConfig(dir, {
      roots: ['/music'],
      server: { enabled: true, port: 5000, token: 's3cret', sessions: [], devices: [], allowInsecure: false }
    })

    expect((await loadConfig(dir)).server).toEqual({
      enabled: true,
      port: 5000,
      token: 's3cret',
      sessions: [],
      devices: [],
      allowInsecure: false
    })
  })

  it('round-trips server sessions and drops malformed ones', async () => {
    await saveConfig(dir, {
      roots: ['/music'],
      server: {
        enabled: true,
        port: 5000,
        token: 's3cret',
        sessions: [{ id: 'a1', createdAt: 123, lastSeen: 124 }],
        devices: [{ token: 'd1', name: 'Phone', createdAt: 10, lastSeen: 20 }],
        allowInsecure: true
      }
    })
    expect((await loadConfig(dir)).server?.sessions).toEqual([{ id: 'a1', createdAt: 123, lastSeen: 124 }])
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
    // Entries predating lastSeen backfill it from creation instead of
    // dropping: the upgrade itself must log nobody out.
    expect((await loadConfig(dir)).server?.sessions).toEqual([{ id: 'ok', createdAt: 7, lastSeen: 7 }])
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
      devices: [],
      allowInsecure: false
    })

    await writeFile(
      configPath(dir),
      JSON.stringify({ version: 1, roots: [], server: { enabled: true, allowInsecure: 1 } }),
      'utf8'
    )
    expect((await loadConfig(dir)).server?.allowInsecure).toBe(false)

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

describe('secret envelopes', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'config-env-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips secrets through envelopes with nothing in the clear', async () => {
    await saveConfig(
      dir,
      {
        roots: ['/music'],
        discogsToken: 'discogs-secret',
        server: {
          enabled: true,
          port: 5000,
          token: 'server-secret',
          allowInsecure: false,
          sessions: [{ id: 'session-secret', createdAt: 10, lastSeen: 20 }],
          devices: [{ token: 'device-secret', name: 'Phone', createdAt: 10, lastSeen: 20 }]
        }
      },
      envelopeBox
    )

    const raw = await readFile(configPath(dir), 'utf8')
    expect(raw).not.toContain('server-secret')
    expect(raw).not.toContain('discogs-secret')
    expect(raw).not.toContain('session-secret')
    expect(raw).not.toContain('device-secret')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const server = parsed['server'] as Record<string, unknown>
    expect(server['token']).toEqual({ enc: expect.any(String) })

    const loaded = await loadConfig(dir, envelopeBox)
    expect(loaded.discogsToken).toBe('discogs-secret')
    expect(loaded.server?.token).toBe('server-secret')
    expect(loaded.server?.sessions).toEqual([{ id: 'session-secret', createdAt: 10, lastSeen: 20 }])
    expect(loaded.server?.devices).toEqual([
      { token: 'device-secret', name: 'Phone', createdAt: 10, lastSeen: 20 }
    ])
  })

  it('reads legacy plaintext files and rewrites them as envelopes', async () => {
    await saveConfig(dir, {
      roots: ['/music'],
      server: {
        enabled: true,
        port: 5000,
        token: 'legacy-secret',
        allowInsecure: false,
        sessions: [],
        devices: []
      }
    })

    // Legacy file loads fine through the vault box (shape check, no version).
    expect((await loadConfig(dir, envelopeBox)).server?.token).toBe('legacy-secret')

    // Next save overwrites in the new shape; the secret never appears bare.
    await saveConfig(
      dir,
      { roots: ['/music'], server: (await loadConfig(dir, envelopeBox)).server },
      envelopeBox
    )
    const raw = await readFile(configPath(dir), 'utf8')
    expect(raw).not.toContain('legacy-secret')
    expect((await loadConfig(dir, envelopeBox)).server?.token).toBe('legacy-secret')
  })

  it('drops envelope secrets instead of crashing when the vault is locked', async () => {
    await saveConfig(
      dir,
      {
        roots: ['/music'],
        discogsToken: 'discogs-secret',
        server: {
          enabled: true,
          port: 5000,
          token: 'server-secret',
          allowInsecure: false,
          sessions: [{ id: 'session-secret', createdAt: 10, lastSeen: 20 }],
          devices: []
        }
      },
      envelopeBox
    )

    const loaded = await loadConfig(dir, lockedBox)
    expect(loaded.roots).toEqual(['/music'])
    expect(loaded.discogsToken).toBeUndefined()
    expect(loaded.server?.token).toBeUndefined()
    expect(loaded.server?.sessions).toEqual([])
    expect(loaded.server?.port).toBe(5000)
  })

  it('writes nothing rather than a secret-less file when locked', async () => {
    const returned = await saveConfig(
      dir,
      {
        roots: ['/music'],
        server: {
          enabled: true,
          port: 5000,
          token: 'server-secret',
          allowInsecure: false,
          sessions: [],
          devices: []
        }
      },
      lockedBox
    )

    // In-memory result is unaffected (the app keeps running on it); with no
    // sealed file to preserve and no sealable secrets, nothing hits disk.
    expect(returned.server?.token).toBe('server-secret')
    await expect(readFile(configPath(dir), 'utf8')).rejects.toThrow()
  })

  it('drops malformed envelopes rather than trusting them', async () => {
    await writeFile(
      configPath(dir),
      JSON.stringify({
        version: 1,
        roots: [],
        server: {
          enabled: true,
          port: 5000,
          token: { enc: 123 },
          sessions: [{ id: { nope: true }, createdAt: 1, lastSeen: 1 }]
        }
      }),
      'utf8'
    )

    const loaded = await loadConfig(dir, envelopeBox)
    expect(loaded.server?.token).toBeUndefined()
    expect(loaded.server?.sessions).toEqual([])
  })

  it('skips the write rather than persisting a secret-less file', async () => {
    // First a sealed file, then a locked-vault save: the file must keep
    // its envelopes instead of being overwritten secret-less.
    await saveConfig(
      dir,
      {
        roots: ['/music'],
        server: {
          enabled: true,
          port: 5000,
          token: 'server-secret',
          allowInsecure: false,
          sessions: [],
          devices: []
        }
      },
      envelopeBox
    )
    const before = await readFile(configPath(dir), 'utf8')

    await saveConfig(
      dir,
      {
        roots: ['/music', '/more'],
        server: {
          enabled: true,
          port: 5000,
          token: 'server-secret',
          allowInsecure: false,
          sessions: [],
          devices: []
        }
      },
      lockedBox
    )

    // Untouched on disk (even the roots change waits), intact in memory.
    expect(await readFile(configPath(dir), 'utf8')).toBe(before)
  })

  it('drops over-long secrets instead of persisting them', async () => {
    const long = 'x'.repeat(2000)
    await saveConfig(dir, { roots: [], discogsToken: long })

    expect((await loadConfig(dir)).discogsToken).toBeUndefined()

    await writeFile(
      configPath(dir),
      JSON.stringify({
        version: 1,
        roots: [],
        server: {
          enabled: true,
          port: 5000,
          sessions: [{ id: long, createdAt: 1, lastSeen: 1 }]
        }
      }),
      'utf8'
    )
    expect((await loadConfig(dir)).server?.sessions).toEqual([])
  })
})
