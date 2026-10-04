import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo } from '@shared/ipc'
import { IPC, LIBRARY_CHANGED_CHANNEL, SCAN_PROGRESS_CHANNEL, type DiscogsArtOutcome, type DiscogsReleaseOutcome, type DiscogsSearchOutcome, type IpcApi, type TagUpdateItem, type TagUpdateOutcome } from '@shared/ipc'
import type { LibrarySummary } from '@shared/ipc'
import type { ScanProgress, AppSettings } from '@shared/types'

const appInfo: AppInfo = {
  electron: process.versions.electron ?? '',
  chrome: process.versions.chrome ?? '',
  node: process.versions.node
}

const api: IpcApi = {
  pickFolders: () => ipcRenderer.invoke(IPC.pickFolders) as Promise<string[]>,
  pickFiles: () => ipcRenderer.invoke(IPC.pickFiles) as Promise<string[]>,
  getLibrary: () => ipcRenderer.invoke(IPC.getLibrary),
  scanLibrary: () => ipcRenderer.invoke(IPC.scanLibrary),
  cancelScan: () => ipcRenderer.invoke(IPC.cancelScan) as Promise<void>,
  removeRoot: (path: string) => ipcRenderer.invoke(IPC.removeRoot, path) as Promise<LibrarySummary>,
  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  setTheme: (theme: string) => ipcRenderer.invoke(IPC.setTheme, theme) as Promise<AppSettings>,
  readFile: (path: string) => ipcRenderer.invoke(IPC.readFile, path) as Promise<ArrayBuffer>,
  readCover: (path: string) => ipcRenderer.invoke(IPC.readCover, path) as Promise<string | null>,
  revealInExplorer: (path: string) => ipcRenderer.invoke(IPC.revealInExplorer, path) as Promise<void>,
  updateTags: (items: readonly TagUpdateItem[]) =>
    ipcRenderer.invoke(IPC.updateTags, items) as Promise<TagUpdateOutcome>,
  setDiscogsToken: (token: unknown) =>
    ipcRenderer.invoke(IPC.setDiscogsToken, token) as Promise<AppSettings>,
  searchDiscogs: (query: unknown) =>
    ipcRenderer.invoke(IPC.searchDiscogs, query) as Promise<DiscogsSearchOutcome>,
  getDiscogsRelease: (id: unknown, kind: unknown) =>
    ipcRenderer.invoke(IPC.getDiscogsRelease, id, kind) as Promise<DiscogsReleaseOutcome>,
  fetchDiscogsArt: (url: unknown) =>
    ipcRenderer.invoke(IPC.fetchDiscogsArt, url) as Promise<DiscogsArtOutcome>,
  onScanProgress: (callback: (progress: ScanProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(SCAN_PROGRESS_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(SCAN_PROGRESS_CHANNEL, listener)
    }
  },
  onLibraryChanged: (callback: (summary: LibrarySummary) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, summary: LibrarySummary): void => {
      callback(summary)
    }
    ipcRenderer.on(LIBRARY_CHANGED_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(LIBRARY_CHANGED_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('equalizer', { ...api, appInfo })
