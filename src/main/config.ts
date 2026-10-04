import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_THEME, isThemeId, type ThemeId } from '@shared/types'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'library.json'

/** Despite the name this holds app settings, not just the music library. */
export interface AppConfig {
  readonly version: number
  readonly roots: readonly string[]
  readonly theme: ThemeId
  /** Discogs personal token. Never sent to the renderer; only its presence is. */
  readonly discogsToken?: string
}

export const EMPTY_CONFIG: AppConfig = {
  version: CONFIG_VERSION,
  roots: [],
  theme: DEFAULT_THEME,
  discogsToken: undefined
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

/** Pasted tokens often carry stray whitespace; anything blank means "no token". */
export function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Never throws: an unreadable or corrupt config just means "no folders chosen yet". */
export async function loadConfig(directory: string): Promise<AppConfig> {
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
    discogsToken: normalizeToken(record.discogsToken)
  }
}

/**
 * Writes through a temp file and renames, so a crash mid-write cannot leave a
 * half-written config that would silently reset the user's library.
 *
 * Takes the whole config (rather than individual fields) so saving one setting
 * can never wipe another — e.g. adding a folder must not drop the Discogs token.
 */
export async function saveConfig(
  directory: string,
  input: { readonly roots: readonly string[]; readonly theme?: ThemeId; readonly discogsToken?: string }
): Promise<AppConfig> {
  const config: AppConfig = {
    version: CONFIG_VERSION,
    roots: normalizeRoots([...input.roots]),
    theme: input.theme !== undefined && isThemeId(input.theme) ? input.theme : DEFAULT_THEME,
    discogsToken: normalizeToken(input.discogsToken)
  }
  const target = configPath(directory)
  const temporary = `${target}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporary, target)
  return config
}