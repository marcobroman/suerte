import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_SERVER_PORT, DEFAULT_THEME, EQ_BAND_COUNT, isThemeId, type DeviceRecord, type PersistedEqSettings, type ServerConfig, type ServerSession, type ThemeId } from '@shared/types'
import { isEncryptedEnvelope, plaintextSecretBox, type SecretBox } from './secrets'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'library.json'

/** Despite the name this holds app settings, not just the music library. */
export interface AppConfig {
  readonly version: number
  readonly roots: readonly string[]
  readonly theme: ThemeId
  /** Discogs personal token. Never sent to the renderer; only its presence is. */
  readonly discogsToken?: string
  readonly eq?: PersistedEqSettings
  readonly server?: ServerConfig
}

export const EMPTY_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  roots: [],
  theme: DEFAULT_THEME,
  discogsToken: undefined,
  eq: undefined,
  server: undefined
}

export function configPath(directory: string): string {
  return join(directory, CONFIG_FILE)
}

/**
 * Keeps only usable absolute-looking entries and drops duplicates, because this file
 * is edited by hand often enough that a typo should not take the library down.
 */
export function normalizeRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const roots: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (roots.includes(trimmed)) continue
    roots.push(trimmed)
  }
  return roots
}

/** Longest persisted secret accepted (tokens are hex dozens of chars; this is slack, not a target). */
export const MAX_SECRET_LENGTH = 1024

/** Pasted tokens often carry stray whitespace; anything blank means "no token". */
export function normalizeToken(value: unknown, box: SecretBox = plaintextSecretBox()): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.length > MAX_SECRET_LENGTH) return undefined
    return trimmed
  }
  // Envelope from a previous save: open it, or drop the field when the
  // vault cannot (locked keyring, moved profile) — never crash the load.
  if (isEncryptedEnvelope(value)) {
    try {
      const opened = box.unprotect(value).trim()
      if (opened === '' || opened.length > MAX_SECRET_LENGTH) return undefined
      return opened
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Shape-checks a saved EQ curve. Anything malformed means "no saved curve"
 * rather than a half-applied one; the renderer clamps ranges on load.
 */
export function normalizePersistedEq(value: unknown): PersistedEqSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const bands = record['bandGainsDb']
  if (!Array.isArray(bands) || bands.length !== EQ_BAND_COUNT) return undefined
  const bandGainsDb: number[] = []
  for (const gain of bands) {
    if (typeof gain !== 'number' || !Number.isFinite(gain)) return undefined
    bandGainsDb.push(gain)
  }
  const preampDb = record['preampDb']
  const bassDb = record['bassDb']
  const trebleDb = record['trebleDb']
  const autoPreamp = record['autoPreamp']
  if (
    typeof preampDb !== 'number' || !Number.isFinite(preampDb) ||
    typeof bassDb !== 'number' || !Number.isFinite(bassDb) ||
    typeof trebleDb !== 'number' || !Number.isFinite(trebleDb) ||
    typeof autoPreamp !== 'boolean'
  ) {
    return undefined
  }
  return { bandGainsDb, preampDb, autoPreamp, bassDb, trebleDb }
}

/** Never throws: an unreadable or corrupt config just means "no folders chosen yet". */
export async function loadConfig(
  directory: string,
  box: SecretBox = plaintextSecretBox()
): Promise<AppConfig> {
  let raw: string
  try {
    raw = await readFile(configPath(directory), 'utf8')
  } catch {
    return EMPTY_CONFIG
  }

  let parsed: unknown
  try {
    // Editors on Windows happily add a byte-order mark, which JSON.parse rejects.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return EMPTY_CONFIG
  }

  if (typeof parsed !== 'object' || parsed === null) return EMPTY_CONFIG
  const record = parsed as Record<string, unknown>
  return {
    version: CONFIG_VERSION,
    roots: normalizeRoots(record.roots),
    theme: isThemeId(record.theme) ? record.theme : DEFAULT_THEME,
    discogsToken: normalizeToken(record.discogsToken, box),
    eq: normalizePersistedEq(record.eq),
    server: normalizeServerConfig(record.server, box)
  }
}

/** A bad port falls back instead of dropping the whole section (and its token). */
export function normalizeServerConfig(
  value: unknown,
  box: SecretBox = plaintextSecretBox()
): ServerConfig | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const port = record['port']
  return {
    enabled: record['enabled'] === true,
    port:
      typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
        ? port
        : DEFAULT_SERVER_PORT,
    token: normalizeToken(record['token'], box),
    allowInsecure: record['allowInsecure'] === true,
    sessions: normalizeServerSessions(record['sessions'], box),
    devices: normalizeDeviceRecords(record['devices'], box)
  }
}

/**
 * Opens a persisted secret: bare strings pass through (legacy file or
 * plaintext box), envelopes go through the vault, anything else is dropped.
 * Secrets are matched exactly — never trimmed — since lookup keys must agree.
 * Over-long values are dropped too: persisted ids are fixed-size hex, so
 * megabytes here mean a hostile or corrupt file, not data.
 */
function openSecret(value: unknown, box: SecretBox): string | undefined {
  let opened: string | undefined
  if (typeof value === 'string') opened = value
  else if (isEncryptedEnvelope(value)) {
    try {
      opened = box.unprotect(value)
    } catch {
      return undefined
    }
  } else return undefined
  if (opened === '' || opened.length > MAX_SECRET_LENGTH) return undefined
  return opened
}

/**
 * Shape-checks persisted login sessions. A hand-edited or corrupt entry is
 * dropped rather than trusted; an empty list simply means "no phones logged
 * in", which is always a safe fallback. Entries predating `lastSeen` backfill
 * it from creation so the upgrade itself logs nobody out.
 */
export function normalizeServerSessions(
  value: unknown,
  box: SecretBox = plaintextSecretBox()
): ServerSession[] {
  if (!Array.isArray(value)) return []
  const sessions: ServerSession[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = openSecret(record['id'], box)
    const createdAt = record['createdAt']
    const lastSeen = record['lastSeen']
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    seen.add(id)
    sessions.push({
      id,
      createdAt,
      lastSeen: typeof lastSeen === 'number' && Number.isFinite(lastSeen) ? lastSeen : createdAt
    })
  }
  return sessions
}

/**
 * Shape-checks persisted paired devices. Same policy as sessions: malformed
 * entries are dropped, duplicates collapse on the token, and names are
 * clamped so a corrupt file cannot inject unbounded strings into the UI.
 */
export function normalizeDeviceRecords(
  value: unknown,
  box: SecretBox = plaintextSecretBox()
): DeviceRecord[] {
  if (!Array.isArray(value)) return []
  const devices: DeviceRecord[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const token = openSecret(record['token'], box)
    const name = record['name']
    const createdAt = record['createdAt']
    const lastSeen = record['lastSeen']
    if (typeof token !== 'string' || token === '' || seen.has(token)) continue
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) continue
    seen.add(token)
    devices.push({
      token,
      name: typeof name === 'string' && name !== '' ? name.slice(0, 64) : 'Phone',
      createdAt,
      lastSeen
    })
  }
  return devices
}

/**
 * Writes through a temp file and renames, so a crash mid-write cannot leave a
 * half-written config that would silently reset the user's library.
 *
 * Takes the whole config (rather than individual fields) so saving one setting
 * can never wipe another — e.g. adding a folder must not drop the Discogs token.
 *
 * Secrets (tokens, session ids, device tokens) are written as `{ enc }`
 * envelopes through the box; the plaintext box used in tests writes them
 * bare. A vault failure mid-save drops that field from the file rather than
 * writing it in the clear — the in-memory config (and return value) is
 * unaffected, so the app keeps running and the next save retries.
 */
export async function saveConfig(
  directory: string,
  input: { readonly roots: readonly string[]; readonly theme?: ThemeId; readonly discogsToken?: string; readonly eq?: PersistedEqSettings; readonly server?: ServerConfig },
  box: SecretBox = plaintextSecretBox()
): Promise<AppConfig> {
  const config: AppConfig = {
    version: CONFIG_VERSION,
    roots: normalizeRoots([...input.roots]),
    theme: input.theme !== undefined && isThemeId(input.theme) ? input.theme : DEFAULT_THEME,
    discogsToken: normalizeToken(input.discogsToken, box),
    eq: normalizePersistedEq(input.eq),
    server: normalizeServerConfig(input.server, box)
  }
  // A dropped secret (vault failure below) must never be persisted as an
  // omission: overwriting a sealed file with a secret-less one would log
  // every phone out on the next restart. Skip the write instead — the
  // in-memory config (and return value) is unaffected, and the next save
  // with a working vault persists everything.
  let dropped = false
  const protect = (secret: string | undefined): string | { enc: string } | undefined => {
    if (secret === undefined) return undefined
    try {
      return box.protect(secret)
    } catch {
      // Vault failure: mark the drop (handled below), never write cleartext.
      dropped = true
      return undefined
    }
  }
  // File shape mirrors AppConfig, except secrets ride in envelopes. Shaped as
  // `unknown` on purpose: the on-disk contract is "JSON with envelopes",
  // not the in-memory model.
  const file: Record<string, unknown> = {
    version: config.version,
    roots: config.roots,
    theme: config.theme,
    discogsToken: protect(config.discogsToken),
    eq: config.eq,
    server: config.server
      ? {
          enabled: config.server.enabled,
          port: config.server.port,
          token: protect(config.server.token),
          allowInsecure: config.server.allowInsecure,
          sessions: config.server.sessions.map((session) => ({
            id: protect(session.id),
            createdAt: session.createdAt,
            lastSeen: session.lastSeen
          })),
          devices: config.server.devices.map((device) => ({
            token: protect(device.token),
            name: device.name,
            createdAt: device.createdAt,
            lastSeen: device.lastSeen
          }))
        }
      : undefined
  }
  if (dropped) {
    // A locked vault plus any save would otherwise overwrite the sealed
    // file with a secret-less one, logging every phone out on restart. Skip
    // the write (non-secret changes wait for the next save); in-memory state
    // and the return value are unaffected.
    return config
  }
  const target = configPath(directory)
  const temporary = `${target}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  // This file holds login-equivalent secrets (server token, sessions, device
  // tokens, Discogs token): owner-only permissions where the platform
  // supports them, same best-effort pattern as the TLS key file.
  try {
    await chmod(temporary, 0o600)
  } catch {
    // Windows has no POSIX modes; the user-data dir is already user-private.
  }
  await rename(temporary, target)
  try {
    // Rename can reset modes on some platforms; lock down the final file too.
    await chmod(target, 0o600)
  } catch {
    // Best effort, as above.
  }
  return config
}