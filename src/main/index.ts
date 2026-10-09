import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { app, BrowserWindow, shell } from 'electron'
import { loadConfig, saveConfig, configPath } from './config'
import { ensureServerCert } from './cert'
import { createIpcContext, registerIpc, rescan } from './ipc'
import { createLibraryServer, selectServerTransport } from './server'
import { readCoverDataUrl } from './library/covers'

// Resolved eagerly because app.getPath is unavailable until the app is ready.
const userDataDir = app.getPath('userData')
const ipcContext = createIpcContext(userDataDir)

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // Picks up files added or removed in Explorer while the app was in the background.
  window.on('focus', () => {
    if (ipcContext.roots.length > 0 && !ipcContext.scanning) void rescan(ipcContext)
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(async () => {
  registerIpc(ipcContext)

  // A crash between config write and rename leaves library.json.tmp holding
  // secrets; it is never read back, so remove it on every launch.
  try {
    await rm(configPath(userDataDir) + '.tmp', { force: true })
  } catch {
    // Best effort: a leftover tmp is inert (never loaded).
  }

  // Folders chosen in an earlier session are restored, then rescanned in the
  // background, so launching the app lands straight on the library.
  const config = await loadConfig(userDataDir)
  ipcContext.roots = [...config.roots]
  ipcContext.theme = config.theme
  ipcContext.discogsToken = config.discogsToken
  ipcContext.eq = config.eq
  if (config.server) ipcContext.serverConfig = { ...config.server }

  const persistServerState = async (): Promise<void> => {
    await saveConfig(userDataDir, {
      roots: ipcContext.roots,
      theme: ipcContext.theme,
      discogsToken: ipcContext.discogsToken,
      eq: ipcContext.eq,
      server: {
        enabled: ipcContext.serverConfig.enabled,
        port: ipcContext.serverConfig.port,
        token: ipcContext.serverConfig.token,
        allowInsecure: ipcContext.serverConfig.allowInsecure,
        sessions: [...ipcContext.serverConfig.sessions],
        devices: ipcContext.serverConfig.devices.map((device) => ({ ...device }))
      }
    })
  }

  ipcContext.server = createLibraryServer({
    getPort: () => ipcContext.serverConfig.port,
    getToken: () => ipcContext.serverConfig.token,
    getTls: () => ipcContext.serverTls,
    getAllowInsecure: () => ipcContext.serverConfig.allowInsecure,
    getSessions: () => ipcContext.serverConfig.sessions,
    saveSessions: (sessions) => {
      ipcContext.serverConfig = { ...ipcContext.serverConfig, sessions: [...sessions] }
      return persistServerState()
    },
    getDevices: () => ipcContext.serverConfig.devices,
    saveDevices: (devices) => {
      ipcContext.serverConfig = {
        ...ipcContext.serverConfig,
        devices: devices.map((device) => ({ ...device }))
      }
      return persistServerState()
    },
    getSummary: () => ({
      tree: ipcContext.tree,
      tracks: ipcContext.tracks,
      trackCount: ipcContext.tracks.length,
      roots: ipcContext.roots,
      missingRoots: ipcContext.missingRoots,
      scanning: ipcContext.scanning
    }),
    readCover: (path) => readCoverDataUrl(path, ipcContext.covers),
    getRoots: () => ipcContext.roots,
    getClientDir: () => {
      // The dev tree has an index.html too, but only a built client (with an
      // assets bundle) is servable as-is.
      const dir = join(__dirname, '..', 'renderer')
      return existsSync(join(dir, 'assets')) ? dir : null
    }
  })
  if (ipcContext.serverConfig.enabled) {
    if (ipcContext.serverConfig.token === undefined) {
      ipcContext.serverConfig = {
        ...ipcContext.serverConfig,
        token: randomBytes(32).toString('hex')
      }
      await persistServerState()
    }
    try {
      ipcContext.serverTls = await ensureServerCert(userDataDir)
    } catch {
      // No identity: fail closed below unless the user allowed insecure.
      ipcContext.serverTls = null
    }
    if (selectServerTransport(ipcContext.serverTls, ipcContext.serverConfig.allowInsecure) === 'disabled') {
      // Enabled but certless and no fallback: stays stopped with a null URL,
      // and the next enable retries. Nothing else about startup depends on it.
    } else {
      try {
        await ipcContext.server.start()
      } catch {
        // A taken port at launch leaves the server stopped; enabling it again
        // later retries. Nothing else about startup depends on it.
      }
    }
  }

  createWindow()

  if (ipcContext.roots.length > 0) void rescan(ipcContext)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})