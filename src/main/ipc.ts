import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { AUDIO_EXTENSIONS } from '@shared/audio-files'
import { IPC, LIBRARY_CHANGED_CHANNEL, SCAN_PROGRESS_CHANNEL, type DiscogsArtOutcome, type DiscogsFailure, type DiscogsReleaseOutcome, type DiscogsSearchOutcome, type LibrarySummary, type TagUpdateItem, type TagUpdateOutcome } from '@shared/ipc'
import type { LibraryTree, PersistedEqSettings, ScanResult, TagWriteResult, ThemeId, Track } from '@shared/types'
import { DEFAULT_THEME, isThemeId, type AppSettings } from '@shared/types'
import { CoverCache, readCoverDataUrl } from './library/covers'
import { normalizePersistedEq, normalizeToken, saveConfig } from './config'
import { createDiscogsClient, DiscogsError } from './discogs'
import { LibraryCache } from './library/cache'
import { findMissingRoots } from './library/roots'
import { scanLibrary } from './library/scan'
import { sanitizeTagEdits, writeTrackTags } from './library/tags'
import { readAudioBytes } from './util/read-bytes'

/**
 * Renderer-supplied paths are trusted: the renderer only ever runs our own bundled
 * code under sandbox + context isolation. If this app ever loads remote content,
 * every handler below needs a containment check against the chosen roots first.
 */
export interface IpcContext {
  roots: string[]
  missingRoots: string[]
  scanning: boolean
  theme: ThemeId
  discogsToken: string | undefined
  eq: PersistedEqSettings | undefined
  tree: LibraryTree
  tracks: readonly Track[]
  readonly cache: LibraryCache
  readonly covers: CoverCache
  readonly configDir: string
}

export function createIpcContext(
  configDir: string,
  roots: readonly string[] = [],
  theme: ThemeId = DEFAULT_THEME
): IpcContext {
  return {
    roots: [...roots],
    missingRoots: [],
    scanning: false,
    theme,
    discogsToken: undefined,
    eq: undefined,
    tree: { artists: [], albums: [] },
    tracks: [],
    cache: new LibraryCache(),
    covers: new CoverCache(),
    configDir
  }
}

function sendProgress(scanned: number, total: number, currentPath: string): void {
  for (const target of BrowserWindow.getAllWindows()) {
    target.webContents.send(SCAN_PROGRESS_CHANNEL, { scanned, total, currentPath })
  }
}

/** Broadcasts the new library so the renderer can refresh without having asked. */
function broadcastLibrary(context: IpcContext): void {
  const summary = summarize(context)
  for (const target of BrowserWindow.getAllWindows()) {
    target.webContents.send(LIBRARY_CHANGED_CHANNEL, summary)
  }
}

async function runScan(context: IpcContext): Promise<ScanResult> {  if (context.scanning) {
    return { added: 0, changed: 0, removed: 0, failed: 0, cancelled: 0, durationMs: 0 }
  }

  context.scanning = true
  try {
    const outcome = await scanLibrary({
      roots: context.roots,
      cache: context.cache,
      // cancelScan clears the flag; remaining files in the parse queue are skipped.
      isCancelled: () => !context.scanning,
      onProgress: (progress) => sendProgress(progress.scanned, progress.total, progress.currentPath)
    })
    context.tree = outcome.tree
    context.tracks = outcome.tracks
    // Covers are cached by path with no mtime check, so any rescan — tag edits
    // included — must drop them; they reload lazily on demand.
    context.covers.clear()
    // Reported rather than pruned: a detached drive comes back on its own.
    context.missingRoots = await findMissingRoots(context.roots)
    broadcastLibrary(context)
    return outcome.result
  } finally {
    context.scanning = false
  }
}

/** Rescans chosen roots and publishes the result to the renderer. */
export async function rescan(context: IpcContext): Promise<ScanResult> {
  return runScan(context)
}
function summarize(context: IpcContext): LibrarySummary {
  return {
    tree: context.tree,
    tracks: context.tracks,
    trackCount: context.tracks.length,
    roots: context.roots,
    missingRoots: context.missingRoots,
    scanning: context.scanning
  }
}

/** The token and EQ curve never leave main in raw form; renderers get presence flags and copies. */
function settingsOf(context: IpcContext): AppSettings {
  return {
    theme: context.theme,
    discogsTokenSet: context.discogsToken !== undefined,
    eq: context.eq ? { ...context.eq, bandGainsDb: [...context.eq.bandGainsDb] } : null
  }
}

function discogsFailure(error: unknown): DiscogsFailure {
  if (error instanceof DiscogsError) return { kind: error.kind, message: error.message }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : 'Discogs request failed.'
  }
}

export function registerIpc(context: IpcContext): void {
  const persistConfig = (): Promise<unknown> =>
    saveConfig(context.configDir, {
      roots: context.roots,
      theme: context.theme,
      discogsToken: context.discogsToken,
      eq: context.eq
    })

  ipcMain.handle(IPC.pickFolders, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    })
    if (result.canceled) return []
    context.roots = [...new Set([...context.roots, ...result.filePaths])]
    // Remembered so the next launch finds the library without asking again.
    await persistConfig()
    return result.filePaths
  })

  ipcMain.handle(IPC.pickFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS.map((e) => e.slice(1)) }]
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(IPC.getLibrary, () => summarize(context))

  ipcMain.handle(IPC.scanLibrary, () => runScan(context))

  ipcMain.handle(IPC.cancelScan, () => {
    context.scanning = false
  })

ipcMain.handle(IPC.removeRoot, async (_event, path: string) => {
    context.roots = context.roots.filter((root) => root !== path)
    await persistConfig()
    await runScan(context)
    return summarize(context)
  })

  ipcMain.handle(IPC.getSettings, (): AppSettings => settingsOf(context))

  ipcMain.handle(IPC.setTheme, async (_event, theme: unknown): Promise<AppSettings> => {
    // The renderer is not trusted with the shape of the value it sends back.
    if (isThemeId(theme)) context.theme = theme
    await persistConfig()
    return settingsOf(context)
  })

  ipcMain.handle(IPC.setDiscogsToken, async (_event, token: unknown): Promise<AppSettings> => {
    context.discogsToken = normalizeToken(token)
    await persistConfig()
    return settingsOf(context)
  })

  ipcMain.handle(IPC.setEqSettings, async (_event, eq: unknown): Promise<AppSettings> => {
    // Malformed curves are ignored rather than wiping a good saved one.
    const normalized = normalizePersistedEq(eq)
    if (normalized !== undefined) {
      context.eq = normalized
      await persistConfig()
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.readFile, (_event, path: string) => readAudioBytes(path))

  ipcMain.handle(IPC.readCover, (_event, path: string) => readCoverDataUrl(path, context.covers))

  ipcMain.handle(IPC.revealInExplorer, (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle(IPC.updateTags, async (_event, items: unknown): Promise<TagUpdateOutcome> => {    // Bulk edits never fail atomically: every file reports its own result.
    const results: TagWriteResult[] = []
    const list = Array.isArray(items) ? items.slice(0, 500) : []
    for (const item of list) {
      const candidate = item as Partial<TagUpdateItem> | null
      if (typeof candidate?.path !== 'string' || candidate.path === '') {
        continue
      }
      results.push(await writeTrackTags(candidate.path, sanitizeTagEdits(candidate.edits)))
    }
    const scan = await runScan(context)
    return { results, scan }
  })

  ipcMain.handle(IPC.searchDiscogs, async (_event, query: unknown): Promise<DiscogsSearchOutcome> => {
    if (typeof query !== 'string' || query.trim() === '') return { ok: true, candidates: [] }
    if (context.discogsToken === undefined) {
      return { ok: false, error: { kind: 'missing-token', message: 'Add a Discogs token in Settings first.' } }
    }
    try {
      const candidates = await createDiscogsClient({ token: context.discogsToken }).searchReleases(query)
      return { ok: true, candidates }
    } catch (error: unknown) {
      return { ok: false, error: discogsFailure(error) }
    }
  })

  ipcMain.handle(IPC.getDiscogsRelease, async (_event, id: unknown, kind: unknown): Promise<DiscogsReleaseOutcome> => {
    if (context.discogsToken === undefined) {
      return { ok: false, error: { kind: 'missing-token', message: 'Add a Discogs token in Settings first.' } }
    }
    if (typeof id !== 'number' || !Number.isFinite(id) || (kind !== 'master' && kind !== 'release')) {
      return { ok: false, error: { kind: 'not-found', message: 'That is not a Discogs release.' } }
    }
    try {
      const release = await createDiscogsClient({ token: context.discogsToken }).getRelease(Math.trunc(id), kind)
      return { ok: true, release }
    } catch (error: unknown) {
      return { ok: false, error: discogsFailure(error) }
    }
  })

  ipcMain.handle(IPC.fetchDiscogsArt, async (_event, url: unknown): Promise<DiscogsArtOutcome> => {
    if (context.discogsToken === undefined) {
      return { ok: false, error: { kind: 'missing-token', message: 'Add a Discogs token in Settings first.' } }
    }
    if (typeof url !== 'string' || url === '') {
      return { ok: false, error: { kind: 'not-found', message: 'There is no cover to download.' } }
    }
    try {
      const art = await createDiscogsClient({ token: context.discogsToken }).fetchArt(url)
      return { ok: true, art }
    } catch (error: unknown) {
      return { ok: false, error: discogsFailure(error) }
    }
  })
}

