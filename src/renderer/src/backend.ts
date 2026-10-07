import type { IpcApi } from '@shared/ipc'

/**
 * Everything the UI needs from "the other side", whether that is the Electron
 * main process (today) or the Onda server over HTTP (phone client).
 *
 * The shape is exactly IpcApi so the Electron backend is just `window.equalizer`
 * with no adapter. Methods group into two tiers for an HTTP implementation:
 *
 * Phone-capable (pure library/playback over the network): getLibrary,
 * onLibraryChanged, readFile, readCover, getSettings, setEqSettings.
 *
 * Desktop-only (local dialogs, filesystem, tagging): pickFolders, pickFiles,
 * scanLibrary, cancelScan, removeRoot, setTheme, setDiscogsToken,
 * revealInExplorer, updateTags, searchDiscogs, getDiscogsRelease,
 * fetchDiscogsArt, onScanProgress. An HTTP backend rejects these; the phone UI
 * never mounts the surfaces that call them.
 */
export type Backend = IpcApi
