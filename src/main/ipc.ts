import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { AUDIO_EXTENSIONS } from '@shared/audio-files'
import { IPC, LIBRARY_CHANGED_CHANNEL, SCAN_PROGRESS_CHANNEL, type DiscogsArtOutcome, type DiscogsFailure, type DiscogsReleaseOutcome, type DiscogsSearchOutcome, type LibrarySummary, type TagUpdateItem, type TagUpdateOutcome } from '@shared/ipc'
import type { LibraryTree, PersistedEqSettings, ScanResult, ServerConfig, TagWriteResult, ThemeId, Track } from '@shared/types'
import { DEFAULT_SERVER_PORT, DEFAULT_THEME, isThemeId, type AppSettings } from '@shared/types'
import { CoverCache, readCoverDataUrl } from './library/covers'
import { normalizePersistedEq, normalizeToken, saveConfig } from './config'
import { ensureServerCert, certCoversIps, localIPv4s, type ServerCert } from './cert'
import { createDiscogsClient, DiscogsError } from './discogs'
import { LibraryCache } from './library/cache'
import { findMissingRoots } from './library/roots'
import { scanLibrary } from './library/scan'
import { sanitizeTagEdits, writeTrackTags } from './library/tags'
import { lanBaseUrl, lanBaseUrls, selectServerTransport, insideRoots, type LibraryServer } from './server'
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
  serverConfig: ServerConfig
  /** Running LAN server, if enabled. Owned by main/index.ts lifecycle. */
  server: LibraryServer | null
  /** Live TLS identity for the server; minted on first enable. */
  serverTls: ServerCert | null
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
    serverConfig: { enabled: false, port: DEFAULT_SERVER_PORT, token: undefined, sessions: [], devices: [], allowInsecure: false },
    server: null,
    serverTls: null,
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
  context.server?.pushLibraryChanged()
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

/** Tokens and curves never leave main in raw form; renderers get presence flags and copies. */
function settingsOf(context: IpcContext): AppSettings {
  const server = context.server
  const tls = server?.tlsStatus() ?? { secure: false, fingerprint: null, expiresAt: null }
  const running = context.serverConfig.enabled && (server?.listening ?? false)
  // Live staleness: no timer needed — every settings read re-checks whether
  // the machine's addresses still fit the serving certificate.
  const certStale =
    running &&
    context.serverTls !== null &&
    !certCoversIps(context.serverTls.cert, localIPv4s())
  return {
    theme: context.theme,
    discogsTokenSet: context.discogsToken !== undefined,
    eq: context.eq ? { ...context.eq, bandGainsDb: [...context.eq.bandGainsDb] } : null,
    server: {
      enabled: context.serverConfig.enabled,
      port: context.serverConfig.port,
      tokenSet: context.serverConfig.token !== undefined,
      allowInsecure: context.serverConfig.allowInsecure,
      url: running
        ? (lanBaseUrl(context.serverConfig.port, tls.secure) ??
          `${tls.secure ? 'https' : 'http'}://localhost:${context.serverConfig.port}`)
        : null,
      urls: running ? lanBaseUrls(context.serverConfig.port, tls.secure) : [],
      secure: tls.secure,
      fingerprint: tls.fingerprint,
      certExpiresAt: tls.expiresAt,
      certStale,
      devices: server?.getDevices() ?? []
    }
  }
}

function serverConfigOf(context: IpcContext): ServerConfig {
  return {
    enabled: context.serverConfig.enabled,
    port: context.serverConfig.port,
    token: context.serverConfig.token,
    allowInsecure: context.serverConfig.allowInsecure,
    sessions: [...context.serverConfig.sessions],
    devices: context.serverConfig.devices.map((device) => ({ ...device }))
  }
}

function discogsFailure(error: unknown): DiscogsFailure {
  if (error instanceof DiscogsError) return { kind: error.kind, message: error.message }
  return {
    kind: 'network',
    message: error instanceof Error ? error.message : 'Discogs request failed.'
  }
}

/**
 * Renderer-supplied paths are untrusted: resolve symlinks and require the
 * result to sit under a configured root, or throw a generic error that
 * reveals nothing about what exists. Callers surface per-file failures.
 */
async function containedPath(context: IpcContext, path: unknown): Promise<string> {
  if (typeof path !== 'string' || path === '') throw new Error('unknown file')
  let real: string
  try {
    real = await realpath(path)
  } catch {
    throw new Error('unknown file')
  }
  const roots: string[] = []
  for (const root of context.roots) {
    try {
      roots.push(await realpath(root))
    } catch {
      // Unreachable roots cannot contain anything right now.
    }
  }
  if (!insideRoots(roots, real)) throw new Error('unknown file')
  return real
}

export function registerIpc(context: IpcContext): void {
  const persistConfig = (): Promise<unknown> =>
    saveConfig(context.configDir, {
      roots: context.roots,
      theme: context.theme,
      discogsToken: context.discogsToken,
      eq: context.eq,
      server: serverConfigOf(context)
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

  ipcMain.handle(IPC.setServerEnabled, async (_event, on: unknown): Promise<AppSettings> => {
    if (typeof on !== 'boolean') return settingsOf(context)
    context.serverConfig = { ...context.serverConfig, enabled: on }
    if (on && context.serverConfig.token === undefined) {
      context.serverConfig = { ...context.serverConfig, token: randomBytes(32).toString('hex') }
    }
    await persistConfig()
    if (on) {
      // The TLS identity is minted before the first listen so the server
      // never serves plain HTTP in production. If generation fails the
      // transport selector fails closed below instead of starting HTTP.
      try {
        context.serverTls = await ensureServerCert(context.configDir)
      } catch {
        context.serverTls = null
      }
      if (selectServerTransport(context.serverTls, context.serverConfig.allowInsecure) !== 'disabled') {
        try {
          await context.server?.start()
        } catch {
          // A taken port leaves the server stopped; the URL stays null so the
          // UI shows it as unreachable instead of pretending otherwise.
        }
      }
    } else {
      await context.server?.stop()
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.setServerInsecure, async (_event, on: unknown): Promise<AppSettings> => {
    if (typeof on !== 'boolean') return settingsOf(context)
    context.serverConfig = { ...context.serverConfig, allowInsecure: on }
    await persistConfig()
    // The policy takes effect immediately: disabling the fallback stops a
    // running plain-HTTP server, enabling it starts a stopped one.
    if (context.server?.listening) {
      await context.server.stop()
    }
    if (
      context.serverConfig.enabled &&
      selectServerTransport(context.serverTls, context.serverConfig.allowInsecure) !== 'disabled'
    ) {
      try {
        await context.server?.start()
      } catch {
        // Same taken-port story: stopped with a null URL.
      }
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.setServerPort, async (_event, port: unknown): Promise<AppSettings> => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return settingsOf(context)
    }
    if (port === context.serverConfig.port) return settingsOf(context)
    context.serverConfig = { ...context.serverConfig, port }
    await persistConfig()
    if (context.server?.listening) {
      await context.server.stop()
      // The port moved but the identity did not; still, never restart into
      // a transport the policy forbids (fail-closed even here).
      if (selectServerTransport(context.serverTls, context.serverConfig.allowInsecure) === 'disabled') {
        return settingsOf(context)
      }
      try {
        await context.server.start()
      } catch {
        // Same taken-port story as enabling: stopped with a null URL.
      }
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.restartServer, async (): Promise<AppSettings> => {
    // Re-reads the identity — renewing it when the network outgrew the old
    // one — then restarts serving so the current certificate takes effect.
    // Renewal changes the fingerprint phones must re-confirm; the UI says so.
    if (context.serverConfig.enabled) {
      try {
        context.serverTls = await ensureServerCert(context.configDir)
      } catch {
        context.serverTls = null
      }
    }
    if (context.server?.listening) {
      await context.server.stop()
    }
    if (
      context.serverConfig.enabled &&
      selectServerTransport(context.serverTls, context.serverConfig.allowInsecure) !== 'disabled'
    ) {
      try {
        await context.server?.start()
      } catch {
        // Taken port: stopped with a null URL.
      }
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.regenerateServerToken, async (): Promise<AppSettings> => {
    // A rotated token must log every phone out: surviving sessions or device
    // tokens would keep the old secret's access alive, defeating the rotation.
    context.serverConfig = {
      ...context.serverConfig,
      token: randomBytes(32).toString('hex'),
      sessions: [],
      devices: []
    }
    try {
      await context.server?.dropSessions()
    } catch {
      // persistConfig below rewrites the same emptied state regardless.
    }
    // Drops first, persist second — and the master-subscriber drop cannot be
    // skipped by a persistence failure between them.
    try {
      await context.server?.dropDevices()
    } finally {
      context.server?.dropMasterSubscribers()
    }
    await persistConfig()
    return settingsOf(context)
  })

  ipcMain.handle(IPC.getServerToken, (): string | null => context.serverConfig.token ?? null)

  ipcMain.handle(IPC.regenerateServerCert, async (): Promise<AppSettings> => {
    // A new identity means phones re-trust once via the new fingerprint;
    // sessions and devices survive because the logins did not change.
    // The server restarts so the new certificate takes effect immediately.
    context.serverTls = await ensureServerCert(context.configDir, true)
    if (context.server?.listening) {
      await context.server.stop()
      try {
        await context.server.start()
      } catch {
        // Same taken-port story: stopped with a null URL.
      }
    }
    return settingsOf(context)
  })

  ipcMain.handle(IPC.getPairingCode, () => {
    // A code is only useful while a phone can actually redeem it.
    if (!context.serverConfig.enabled || !context.server?.listening) return null
    return context.server.issuePairingCode()
  })

  ipcMain.handle(IPC.burnPairingCode, (_event, code: unknown): void => {
    if (typeof code === 'string' && code !== '') context.server?.burnPairingCode(code)
  })

  ipcMain.handle(IPC.revokeServerDevice, async (_event, id: unknown): Promise<AppSettings> => {
    if (typeof id === 'string' && context.server) {
      await context.server.revokeDevice(id)
    }
    await persistConfig()
    return settingsOf(context)
  })

  ipcMain.handle(IPC.readFile, async (_event, path: string) => readAudioBytes(await containedPath(context, path)))

  ipcMain.handle(IPC.readCover, (_event, path: string) =>
    containedPath(context, path).then((file) => readCoverDataUrl(file, context.covers))
  )

  ipcMain.handle(IPC.revealInExplorer, async (_event, path: string) => {
    shell.showItemInFolder(await containedPath(context, path))
  })

  ipcMain.handle(IPC.updateTags, async (_event, items: unknown): Promise<TagUpdateOutcome> => {    // Bulk edits never fail atomically: every file reports its own result.
    const results: TagWriteResult[] = []
    const list = Array.isArray(items) ? items.slice(0, 500) : []
    for (const item of list) {
      const candidate = item as Partial<TagUpdateItem> | null
      if (typeof candidate?.path !== 'string' || candidate.path === '') {
        continue
      }
      let file: string
      try {
        file = await containedPath(context, candidate.path)
      } catch {
        results.push({
          path: candidate.path,
          ok: false,
          error: { kind: 'unreadable', message: 'Outside the music library.' }
        })
        continue
      }
      results.push(await writeTrackTags(file, sanitizeTagEdits(candidate.edits)))
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

