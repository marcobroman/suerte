import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibrarySummary } from '@shared/ipc'
import type { Album, EqSettings, PersistedEqSettings, ThemeId, Track } from '@shared/types'
import { extensionOf } from '@shared/audio-files'
import { formatDuration } from './format'
import { AlbumGrid } from './library/AlbumGrid'
import { AlbumView } from './library/AlbumView'
import { AutoTagDialog } from './library/AutoTagDialog'
import { EqPanel } from './library/EqPanel'
import { NowPlayingBar } from './library/NowPlayingBar'
import { OverflowMenu } from './library/OverflowMenu'
import { QueueList } from './library/QueueList'
import { Sidebar } from './library/Sidebar'
import { SortControl } from './library/SortControl'
import { applyTheme, resolveTheme } from './library/themes'
import { ThemeMenu } from './library/ThemeMenu'
import { ServerSettingsMenu } from './library/ServerSettingsMenu'
import { autoTagFilesOf, buildAutoTagQuery } from './library/autotag'
import { eqPresetById } from './library/eqPresets'
import { defaultEqSettings, normalizeEqSettings } from './audio/settings'
import { useServerAdmin, type ServerAdmin } from './useServerAdmin'
import { usePairing } from './usePairing'
import {
  ALL_SELECTION,
  ALBUM_SORT_OPTIONS,
  buildLibraryIndex,
  matchTrack,
  resolveView,
  selectionForAlbum,
  sortAlbums,
  tracksForAlbum,
  type AlbumSortDir,
  type AlbumSortKey,
  type Selection
} from './library/view'
import type { PlaybackControls } from './usePlaybackEngine'
import { LoggedOutError, ServerIdentityChangedError, type HttpBackend } from './http-backend'
import type { Backend } from './backend'

export interface AppProps {
  readonly backend: Backend
  readonly playback: PlaybackControls
  /** Phone client: desktop-only surfaces (folders, tagging, server admin) stay hidden. */
  readonly phone: boolean
  /** Phone only: the device was logged out (expiry/revoke) — return to boot. */
  readonly onLoggedOut?: (notice: string) => void
}

export function App({ backend, playback, phone, onLoggedOut }: AppProps) {
  const [summary, setSummary] = useState<LibrarySummary | null>(null)
  const [theme, setThemeState] = useState<ThemeId>(() =>
    resolveTheme(document.documentElement.dataset.theme)
  )
  const [query, setQuery] = useState('')
  const [scanStatus, setScanStatus] = useState('no library yet')
  const [busy, setBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [discogsTokenSet, setDiscogsTokenSet] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMessage, setTokenMessage] = useState('')
  // Ref bridge for the two server hooks (see usePairing's GetServerAdmin):
  // pairing jobs only run on clicks, always after this commit, so the ref
  // is populated by the time any getter call happens. Assigned during render
  // because no effect runs before a (nonexistent) render-time job could.
  const adminRef = useRef<ServerAdmin | null>(null)
  const getAdmin = useCallback((): ServerAdmin => {
    const admin = adminRef.current
    if (!admin) throw new Error('server admin not ready')
    return admin
  }, [])
  const pairing = usePairing(backend, getAdmin)
  const admin = useServerAdmin(backend, pairing.qr)
  adminRef.current = admin
  const { serverBusy, setServerBusy, refreshServerState } = admin
  const { qrCode, hideQrCode } = pairing
  const [sortKey, setSortKey] = useState<AlbumSortKey>('artist')
  const [sortDir, setSortDir] = useState<AlbumSortDir>('asc')
  const [autoTag, setAutoTag] = useState<{
    tracks: readonly Track[]
    skipped: number
    initialQuery: string
  } | null>(null)
  const [eqOpen, setEqOpen] = useState(false)
  const [queueSheetOpen, setQueueSheetOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  // Selection history, so drilling into an artist and then an album can be undone.
  const [history, setHistory] = useState<readonly Selection[]>([ALL_SELECTION])
  const [cursor, setCursor] = useState(0)

  const selection = history[cursor] ?? ALL_SELECTION
  const index = useMemo(
    () => buildLibraryIndex(summary?.tree ?? { artists: [], albums: [] }, summary?.tracks ?? []),
    [summary]
  )
  const view = useMemo(() => resolveView(index, selection, query), [index, selection, query])

  // A non-empty search takes over the content area with global results, so there
  // is no need to navigate back to All albums to filter the library. Clearing
  // the query restores whatever was being viewed.
  const searching = query.trim() !== ''
  const searchView = useMemo(
    () => resolveView(index, ALL_SELECTION, query),
    [index, query]
  )
  const searchTracks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    return (summary?.tracks ?? []).filter((track) => matchTrack(track, needle))
  }, [summary, query])

  const playbackRef = useRef(playback)
  playbackRef.current = playback
  // Latest callback without resubscribing the library effect below.
  const loggedOutRef = useRef(onLoggedOut)
  loggedOutRef.current = onLoggedOut

  useEffect(() => {
    const unsubscribeProgress = backend.onScanProgress((progress) => {
      setScanStatus(
        progress.total > 0 ? `scanning ${progress.scanned}/${progress.total}` : 'scanning'
      )
    })
    // Main can rescan on its own, for instance when the window regains focus.
    const unsubscribeLibrary = backend.onLibraryChanged((next) => {
      setSummary(next)
      setScanStatus('library updated')
    })
    void backend
      .getLibrary()
      .then((next) => {
        setSummary(next)
        // Roots on desktop, tracks on phone (whose roots are always empty).
        if (next.roots.length > 0 || next.trackCount > 0) setScanStatus('ready')
      })
      .catch((error: unknown) => {
        // Logged out mid-life (expiry, desktop revoke) or facing a changed
        // server identity: no retry makes sense here — hand back to the boot
        // screen with the reason instead of an error.
        if (error instanceof LoggedOutError || error instanceof ServerIdentityChangedError) {
          loggedOutRef.current?.(error.message)
          return
        }
        setScanStatus(`error: ${String(error)}`)
      })
    return () => {
      unsubscribeProgress()
      unsubscribeLibrary()
    }
  }, [backend])

  useEffect(() => {
    void backend
      .getSettings()
      .then((settings) => {
        const resolved = resolveTheme(settings.theme)
        applyTheme(resolved, document.documentElement)
        setThemeState(resolved)
        setDiscogsTokenSet(settings.discogsTokenSet)
        refreshServerState(settings)
        if (settings.eq) {
          playbackRef.current.setEq({
            ...normalizeEqSettings(settings.eq),
            masterVolume: playbackRef.current.status.volume
          })
        }
        setSettingsLoaded(true)
      })
      .catch(() => undefined)
  }, [backend, refreshServerState])

  const saveToken = useCallback(() => {
    setTokenBusy(true)
    setTokenMessage('')
    void backend
      .setDiscogsToken(tokenDraft)
      .then(
        (settings) => {
          setDiscogsTokenSet(settings.discogsTokenSet)
          setTokenDraft('')
          setTokenMessage(settings.discogsTokenSet ? 'Token saved.' : 'Token cleared.')
        },
        () => setTokenMessage('Could not save the token.')
      )
      .finally(() => setTokenBusy(false))
  }, [tokenDraft, backend])

  const clearToken = useCallback(() => {
    setTokenBusy(true)
    setTokenMessage('')
    void backend
      .setDiscogsToken('')
      .then(
        (settings) => {
          setDiscogsTokenSet(settings.discogsTokenSet)
          setTokenMessage('Token cleared.')
        },
        () => setTokenMessage('Could not clear the token.')
      )
      .finally(() => setTokenBusy(false))
  }, [backend])

  const logoutPhone = useCallback(() => {
    if (!phone) return
    // PhoneRoot always hands an HttpBackend here; the cast narrows the
    // shared Backend seam to the phone-only logout call.
    const httpBackend = backend as HttpBackend
    setServerBusy(true)
    void httpBackend
      .logout()
      .catch(() => undefined)
      .then(() => loggedOutRef.current?.('Logged out on this phone.'))
  }, [backend, phone, setServerBusy])

  /**
   * Cover-image failures feed the phone's auth probe: tags report no status,
   * so a burst of broken covers is the only signal a dead credential sends
   * through images. The probe itself is debounced backend-side; desktop
   * backends have no probe, so this is a phone-only no-op there.
   */
  const probeCovers = useCallback((): void => {
    if (!phone) return
    void (backend as HttpBackend).probeAuthAfterFailure()
  }, [backend, phone])

  // Closing Settings with a QR on screen discards it like Hide does: the
  // displayed code is burned, so a photo of it stops working immediately.
  useEffect(() => {
    if (!settingsOpen && qrCode !== null) hideQrCode()
  }, [settingsOpen, qrCode, hideQrCode])

  const changeTheme = useCallback((next: ThemeId) => {
    // Applied immediately; main confirms and persists it.
    applyTheme(next, document.documentElement)
    setThemeState(next)
    void backend.setTheme(next).then(
      (settings) => setThemeState(resolveTheme(settings.theme)),
      () => setScanStatus('could not save theme')
    )
  }, [backend])

  const select = useCallback(
    (next: Selection) => {
      setHistory((entries) => [...entries.slice(0, cursor + 1), next])
      setCursor((value) => value + 1)
      // Closes the navigation drawer on narrow screens; harmless on desktop.
      setNavOpen(false)
    },
    [cursor]
  )

  const openAlbum = useCallback((album: Album) => select(selectionForAlbum(album)), [select])

  const chooseFolders = useCallback(() => {
    setBusy(true)
    setScanStatus('choosing folders')
    void (async () => {
      try {
        const picked = await backend.pickFolders()
        if (picked.length === 0) {
          setScanStatus('cancelled')
          return
        }
        setScanStatus('scanning')
        const result = await backend.scanLibrary()
        setScanStatus(
          `+${result.added} new, ${result.changed} changed, ${result.removed} removed, ` +
            `${result.failed} failed in ${result.durationMs}ms`
        )
      } catch (error: unknown) {
        setScanStatus(`error: ${String(error)}`)
      } finally {
        setBusy(false)
      }
    })()
  }, [backend])

  const removeRoot = useCallback((path: string) => {
    setScanStatus('forgetting folder')
    void backend
      .removeRoot(path)
      .then((next) => {
        setSummary(next)
        setScanStatus('folder removed')
      })
      .catch((error: unknown) => setScanStatus(`error: ${String(error)}`))
  }, [backend])

  const reveal = useCallback((path: string) => {
    void backend.revealInExplorer(path)
  }, [backend])

  /**
   * Non-empty album guard: resolves the album's tracks and runs fn only
   * when there is something to play. Identity follows `index`.
   */
  const withAlbumTracks = useCallback(
    (album: Album, fn: (tracks: Track[]) => void): void => {
      const tracks = tracksForAlbum(index, album)
      if (tracks.length > 0) fn(tracks)
    },
    [index]
  )
  /** Indexed-track guard for the current view; identity follows its tracks. */
  const withViewTrack = useCallback(
    (trackIndex: number, fn: (track: Track) => void): void => {
      const track = view.tracks[trackIndex]
      if (track) fn(track)
    },
    [view.tracks]
  )
  /** Indexed-track guard for search results; identity follows its tracks. */
  const withSearchTrack = useCallback(
    (trackIndex: number, fn: (track: Track) => void): void => {
      const track = searchTracks[trackIndex]
      if (track) fn(track)
    },
    [searchTracks]
  )
  /**
   * Non-empty list guard for whole-list actions (play-all, queue-visible).
   * The list passes through by reference; copies (for addNext/addLast)
   * stay at the call site exactly as before.
   */
  const withTracks = useCallback(
    (tracks: readonly Track[], fn: (tracks: readonly Track[]) => void): void => {
      if (tracks.length > 0) fn(tracks)
    },
    []
  )

  const playArtist = useCallback(() => {
    withTracks(view.tracks, (tracks) => playback.playQueue(tracks, 0))
  }, [view.tracks, playback, withTracks])

  const playAlbum = useCallback(
    (album: Album) => {
      withAlbumTracks(album, (tracks) => playback.playQueue(tracks, 0))
    },
    [withAlbumTracks, playback]
  )

  const queueAlbumNext = useCallback(
    (album: Album) => {
      withAlbumTracks(album, (tracks) => playback.addNext(tracks))
    },
    [withAlbumTracks, playback]
  )

  const queueAlbumLast = useCallback(
    (album: Album) => {
      withAlbumTracks(album, (tracks) => playback.addLast(tracks))
    },
    [withAlbumTracks, playback]
  )

  const playTrackAt = useCallback(
    (trackIndex: number) => {
      withTracks(view.tracks, (tracks) => playback.playQueue(tracks, trackIndex))
    },
    [view.tracks, playback, withTracks]
  )

  const playAllVisible = useCallback(() => {
    withTracks(view.tracks, (tracks) => playback.playQueue(tracks, 0))
  }, [view.tracks, playback, withTracks])

  const queueTrackNext = useCallback(
    (trackIndex: number) => {
      withViewTrack(trackIndex, (track) => playback.addNext([track]))
    },
    [withViewTrack, playback]
  )

  const queueTrackLast = useCallback(
    (trackIndex: number) => {
      withViewTrack(trackIndex, (track) => playback.addLast([track]))
    },
    [withViewTrack, playback]
  )

  const queueVisibleNext = useCallback(() => {
    withTracks(view.tracks, (tracks) => playback.addNext([...tracks]))
  }, [view.tracks, playback, withTracks])

  const queueVisibleLast = useCallback(() => {
    withTracks(view.tracks, (tracks) => playback.addLast([...tracks]))
  }, [view.tracks, playback, withTracks])

  const openAutoTagTracks = useCallback((tracks: readonly Track[]) => {
    const writable = tracks.filter((track) => extensionOf(track.path) === '.mp3')
    setAutoTag({
      tracks: writable,
      skipped: tracks.length - writable.length,
      initialQuery: buildAutoTagQuery(autoTagFilesOf(tracks))
    })
  }, [])

  const autoTagVisibleAlbum = useCallback(() => {
    withTracks(view.tracks, openAutoTagTracks)
  }, [view.tracks, openAutoTagTracks, withTracks])

  const autoTagVisibleTrack = useCallback(
    (trackIndex: number) => {
      withViewTrack(trackIndex, (track) => openAutoTagTracks([track]))
    },
    [withViewTrack, openAutoTagTracks]
  )

  const autoTagGridAlbum = useCallback(
    (album: Album) => {
      openAutoTagTracks(tracksForAlbum(index, album))
    },
    [index, openAutoTagTracks]
  )

  const togglePlayback = useCallback(() => {
    // First play ever: the queue is still empty, so start what is on screen.
    if (playback.status.queueLength === 0) {
      if (searching) {
        if (searchTracks.length > 0) {
          playback.playQueue(searchTracks, 0)
          return
        }
        const first = searchView.albums[0]
        if (first) {
          const tracks = tracksForAlbum(index, first)
          if (tracks.length > 0) playback.playQueue(tracks, 0)
        }
        return
      }
      if (view.tracks.length === 0) return
      playback.playQueue(view.tracks, 0)
      return
    }
    playback.toggle()
  }, [playback, view.tracks, searching, searchTracks, searchView, index])

  useEffect(() => {
    // Spacebar is a global play/pause toggle. Typing and open menus keep their
    // own Space behavior; everything else (including a focused Play button,
    // which would otherwise replay from the start) toggles playback.
    // preventDefault on keydown also suppresses native button activation.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable], [role="menu"]')) {
        return
      }
      event.preventDefault()
      togglePlayback()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [togglePlayback])

  useEffect(() => {
    if (summary) playbackRef.current.refreshTracks(summary.tracks)
  }, [summary])

  const updateEq = useCallback(
    (patch: Partial<EqSettings>) => {
      // Any hand tweak leaves the preset behind; the header shows it only while exact.
      setActivePresetId(null)
      playback.setEq({ ...playback.status.eq, ...patch })
    },
    [playback]
  )

  const applyEqPreset = useCallback(
    (presetId: string) => {
      const preset = eqPresetById(presetId)
      if (!preset) return
      setActivePresetId(presetId)
      playback.setEq({
        ...playback.status.eq,
        bandGainsDb: [...preset.bandGainsDb],
        bassDb: preset.bassDb,
        trebleDb: preset.trebleDb
      })
    },
    [playback]
  )

  const resetEq = useCallback(() => {
    setActivePresetId('flat')
    playback.setEq({ ...defaultEqSettings(), masterVolume: playback.status.volume })
  }, [playback])

  // Persisted debounced, and only after the saved curve has loaded, so the
  // flat defaults can never overwrite a stored curve on startup.
  const lastSavedEq = useRef<string | null>(null)
  useEffect(() => {
    if (!settingsLoaded) return
    const eq = playback.status.eq
    const persisted: PersistedEqSettings = {
      bandGainsDb: [...eq.bandGainsDb],
      preampDb: eq.preampDb,
      autoPreamp: eq.autoPreamp,
      bassDb: eq.bassDb,
      trebleDb: eq.trebleDb
    }
    const key = JSON.stringify(persisted)
    if (key === lastSavedEq.current) return
    const timer = setTimeout(() => {
      void backend.setEqSettings(persisted).then(
        () => {
          lastSavedEq.current = key
        },
        () => undefined
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [settingsLoaded, playback.status.eq, backend])

  const openSearchAlbum = useCallback(
    (album: Album) => {
      setQuery('')
      openAlbum(album)
    },
    [openAlbum]
  )

  const playSearchTracks = useCallback(() => {
    withTracks(searchTracks, (tracks) => playback.playQueue(tracks, 0))
  }, [searchTracks, playback, withTracks])

  const playSearchTrackAt = useCallback(
    (trackIndex: number) => {
      // A results list is a grab-bag, not a listening context, so a click plays
      // just that track. Bulk actions (Play all, queue menus) cover the rest.
      withSearchTrack(trackIndex, (track) => playback.playQueue([track], 0))
    },
    [withSearchTrack, playback]
  )

  const queueSearchTrackNext = useCallback(
    (trackIndex: number) => {
      withSearchTrack(trackIndex, (track) => playback.addNext([track]))
    },
    [withSearchTrack, playback]
  )

  const queueSearchTrackLast = useCallback(
    (trackIndex: number) => {
      withSearchTrack(trackIndex, (track) => playback.addLast([track]))
    },
    [withSearchTrack, playback]
  )

  const canPlay =
    playback.status.queueLength > 0 ||
    (searching
      ? searchTracks.length > 0 || searchView.albums.length > 0
      : view.tracks.length > 0)

  const toggleSortDir = useCallback(() => {
    setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
  }, [])

  // Every tile on an artist page shares the artist, so that option is hidden
  // there; an artist sort silently behaves as title order via the tiebreak.
  const browseSortOptions =
    selection.kind === 'artist'
      ? ALBUM_SORT_OPTIONS.filter((option) => option.id !== 'artist')
      : ALBUM_SORT_OPTIONS
  const browseSortKey: AlbumSortKey =
    selection.kind === 'artist' && sortKey === 'artist' ? 'title' : sortKey
  const sortedBrowseAlbums = useMemo(
    () => sortAlbums(view.albums, browseSortKey, sortDir),
    [view.albums, browseSortKey, sortDir]
  )
  const sortedSearchAlbums = useMemo(
    () => sortAlbums(searchView.albums, sortKey, sortDir),
    [searchView.albums, sortKey, sortDir]
  )

  const album = selection.kind === 'album' ? index.albumsByKey.get(selection.albumKey) : undefined
  const heading =
    selection.kind === 'artist'
      ? selection.artist
      : selection.kind === 'album'
        ? (album?.title ?? 'Album')
        : 'All albums'
  const subheading =
    selection.kind === 'artist'
      ? `${view.albums.length} ${view.albums.length === 1 ? 'album' : 'albums'}`
      : selection.kind === 'album'
        ? (album?.artist ?? '')
        : query.trim() === ''
          ? `${index.tree.albums.length} in your library`
          : `${view.albums.length} of ${index.tree.albums.length} in your library`

  return (
    <div className="app">
      <div className="app-body">
        {navOpen && (
          <button
            type="button"
            className="scrim"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          />
        )}
        <Sidebar
          index={index}
          artists={view.artists}
          selection={selection}
          navOpen={navOpen}
          albumCount={index.tree.albums.length}
          trackCount={summary?.trackCount ?? 0}
          missingRoots={summary?.missingRoots ?? []}
          query={query}
          phone={phone}
          onCoverError={probeCovers}
          onSelect={select}
          onRemoveRoot={removeRoot}
        />

        <main className="main">
          <header className="topbar">
            <button
              type="button"
              className="round-button menu-button"
              onClick={() => setNavOpen((open) => !open)}
              aria-label="Open navigation"
              aria-expanded={navOpen}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" fill="currentColor" />
              </svg>
            </button>
            <div className="history-buttons">
              <button
                type="button"
                className="round-button"
                onClick={() => setCursor((value) => Math.max(0, value - 1))}
                disabled={cursor === 0}
                aria-label="Back"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="M15.5 4 7 12l8.5 8z" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                className="round-button"
                onClick={() => setCursor((value) => Math.min(history.length - 1, value + 1))}
                disabled={cursor >= history.length - 1}
                aria-label="Forward"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="M8.5 4 17 12l-8.5 8z" fill="currentColor" />
                </svg>
              </button>
            </div>

            <input
              className="search"
              type="search"
              placeholder="Search library"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search library"
            />

            <div className="topbar-right">
              <p className="status">{scanStatus}</p>
              <div className="settings-wrap">
                <button
                  type="button"
                  className="round-button"
                  onClick={() => setSettingsOpen((open) => !open)}
                  aria-label="Settings"
                  aria-expanded={settingsOpen}
                  title="Settings"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      d="M12 8.5A3.5 3.5 0 1 0 12 15.5 3.5 3.5 0 0 0 12 8.5zm9 3.5 1.8 1.4-1.8 3.1-2.1-.9a7.6 7.6 0 0 1-1.7 1L16.9 19H13l-.3-2.4a7.6 7.6 0 0 1-1.7-1l-2.1.9-1.8-3.1L8.9 12a7.6 7.6 0 0 1 0-2L7.1 8.6l1.8-3.1 2.1.9a7.6 7.6 0 0 1 1.7-1L13 3h3.9l.3 2.4a7.6 7.6 0 0 1 1.7 1l2.1-.9 1.8 3.1L21 10a7.6 7.6 0 0 1 0 2z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
                {settingsOpen && (
                  <div className="settings-menu" role="menu" aria-label="Settings">
                    {!phone && (
                      <>
                        <p className="settings-label">Library</p>
                        <button
                          type="button"
                          role="menuitem"
                          className="settings-item"
                          disabled={busy}
                          onClick={() => {
                            setSettingsOpen(false)
                            chooseFolders()
                          }}
                        >
                          {busy ? 'Scanning…' : 'Add music folders'}
                        </button>
                      </>
                    )}
                    {!phone && (
                      <>
                        <p className="settings-label">Discogs</p>
                    <p className="settings-note">
                      {discogsTokenSet
                        ? 'Token saved — auto-tag is on.'
                        : 'Add a personal token to enable auto-tag.'}
                    </p>
                    <div className="token-row">
                      <input
                        type="password"
                        className="token-input"
                        placeholder="Personal access token"
                        value={tokenDraft}
                        onChange={(event) => setTokenDraft(event.target.value)}
                        aria-label="Discogs personal access token"
                      />
                      <button
                        type="button"
                        className="token-save"
                        disabled={tokenBusy || tokenDraft.trim() === ''}
                        onClick={saveToken}
                      >
                        Save
                      </button>
                    </div>
                    {discogsTokenSet && (
                      <button
                        type="button"
                        role="menuitem"
                        className="settings-item"
                        disabled={tokenBusy}
                        onClick={clearToken}
                      >
                        Clear token
                      </button>
                    )}
                    {tokenMessage !== '' && <p className="settings-note">{tokenMessage}</p>}
                      </>
                    )}
                    {!phone && <ServerSettingsMenu admin={admin} pairing={pairing} />}
                    {phone && (
                      <>
                        <p className="settings-label">This phone</p>
                        <button
                          type="button"
                          role="menuitem"
                          className="settings-item"
                          disabled={serverBusy}
                          onClick={logoutPhone}
                        >
                          Log out this phone
                        </button>
                      </>
                    )}
                    <p className="settings-label">Theme</p>
                    <ThemeMenu
                      current={theme}
                      onSelect={(id) => {
                        changeTheme(id)
                        setSettingsOpen(false)
                      }}
                    />
                  </div>
                )}
              </div>
            </div>
          </header>

          <div className="content">
            {searching ? (
              <>
                <div className="content-header">
                  <h1>Results for “{query.trim()}”</h1>
                  <p className="content-sub">
                    {searchView.albums.length}{' '}
                    {searchView.albums.length === 1 ? 'album' : 'albums'} ·{' '}
                    {searchTracks.length}{' '}
                    {searchTracks.length === 1 ? 'track' : 'tracks'}
                  </p>
                  <div className="album-actions">
                    {searchTracks.length > 0 && (
                      <button
                        type="button"
                        className="primary-button header-play"
                        onClick={playSearchTracks}
                      >
                        ▶ Play all
                      </button>
                    )}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setQuery('')}
                    >
                      Clear search
                    </button>
                  </div>
                </div>
                {searchView.albums.length === 0 && searchTracks.length === 0 && (
                  <p className="empty">No results. Try a different search.</p>
                )}
                {searchView.albums.length > 0 && (
                  <>
                    <div className="section-head">
                      <p className="nav-label">Albums</p>
                      <SortControl
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onKeyChange={setSortKey}
                        onDirToggle={toggleSortDir}
                      />
                    </div>
                    <AlbumGrid
                      albums={sortedSearchAlbums}
                      query=""
                      phone={phone}
                      onCoverError={probeCovers}
                      onOpen={openSearchAlbum}
                      onPlay={playAlbum}
                      onQueueNext={queueAlbumNext}
                      onQueueLast={queueAlbumLast}
                      onAutoTag={autoTagGridAlbum}
                    />
                  </>
                )}
                {searchTracks.length > 0 && (
                  <>
                    <p className="nav-label">Tracks</p>
                    <ol className="tracklist">
                      {searchTracks.map((track, trackIndex) => {
                        const active = track.path === playback.status.track?.path
                        return (
                          <li
                            key={`${track.path}#${trackIndex}`}
                            className={active ? 'track active' : 'track'}
                          >
                            <button
                              type="button"
                              className="track-play"
                              onClick={() => playSearchTrackAt(trackIndex)}
                              aria-label={`Play ${track.title}`}
                            >
                              <span className="track-number">{trackIndex + 1}</span>
                              <span className="track-playicon">
                                {active && playback.status.state === 'playing' ? '❙❙' : '▶'}
                              </span>
                            </button>
                            <span className="track-title">{track.title}</span>
                            <span className="track-duration">
                              {formatDuration(track.durationSec)}
                            </span>
                            <OverflowMenu
                              ariaLabel={`More actions for ${track.title}`}
                              className="track-more"
                              items={[
                                { label: 'Play', onSelect: () => playSearchTrackAt(trackIndex) },
                                {
                                  label: 'Play next',
                                  onSelect: () => queueSearchTrackNext(trackIndex)
                                },
                                {
                                  label: 'Add to queue',
                                  onSelect: () => queueSearchTrackLast(trackIndex)
                                },
                                ...(!phone
                                  ? [{ label: 'Show in Explorer', onSelect: () => reveal(track.path) }]
                                  : [])
                              ]}
                            />
                          </li>
                        )
                      })}
                    </ol>
                  </>
                )}
              </>
            ) : album === undefined ? (
              <>
                <div className="content-header">
                  <h1>{heading}</h1>
                  <p className="content-sub">{subheading}</p>
                  {selection.kind === 'artist' && view.tracks.length > 0 && (
                    <button
                      type="button"
                      className="primary-button header-play"
                      onClick={playArtist}
                    >
                      ▶ Play all
                    </button>
                  )}
                </div>
                <SortControl
                  sortKey={browseSortKey}
                  sortDir={sortDir}
                  options={browseSortOptions}
                  onKeyChange={setSortKey}
                  onDirToggle={toggleSortDir}
                />
                <AlbumGrid
                  albums={sortedBrowseAlbums}
                  query={query}
                  phone={phone}
                  onCoverError={probeCovers}
                  onOpen={openAlbum}
                  onPlay={playAlbum}
                  onQueueNext={queueAlbumNext}
                  onQueueLast={queueAlbumLast}
                  onAutoTag={autoTagGridAlbum}
                />
              </>
            ) : (
              <AlbumView
                album={album}
                tracks={view.tracks}
                query={query}
                phone={phone}
                onCoverError={probeCovers}
                currentPath={playback.status.track?.path ?? null}
                playing={playback.status.state === 'playing'}
                onPlay={playTrackAt}
                onPlayAll={playAllVisible}
                onAddNext={queueTrackNext}
                onAddLast={queueTrackLast}
                onQueueAlbumNext={queueVisibleNext}
                onQueueAlbumLast={queueVisibleLast}
                onAutoTagAlbum={autoTagVisibleAlbum}
                onAutoTagTrack={autoTagVisibleTrack}
                onReveal={reveal}
              />
            )}
          </div>
        </main>
      </div>

      <div className="player-zone">
        {eqOpen && (
          <EqPanel
            eq={playback.status.eq}
            activePresetId={activePresetId}
            onChange={updateEq}
            onPreset={applyEqPreset}
            onReset={resetEq}
          />
        )}
        {queueSheetOpen && (
          <section className="queue-sheet" aria-label="Playback queue">
            <header className="queue-sheet-head">
              <h2>Queue{playback.status.queue.length > 0 ? ` · ${playback.status.queue.length}` : ''}</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setQueueSheetOpen(false)}
                aria-label="Close queue"
              >
                ✕
              </button>
            </header>
            <QueueList
              queue={playback.status.queue}
              currentIndex={playback.status.index}
              playing={playback.status.state === 'playing'}
              onPlayAt={(queueIndex) => void playback.playAt(queueIndex)}
              onRemoveAt={(queueIndex) => playback.removeAt(queueIndex)}
            />
          </section>
        )}
        <NowPlayingBar
          track={playback.status.track}
          state={playback.status.state}
          positionSec={playback.positionSec}
          durationSec={playback.status.durationSec}
          volume={playback.status.volume}
          canPlay={canPlay}
          eqOpen={eqOpen}
          queueOpen={queueSheetOpen}
          phone={phone}
          onCoverError={probeCovers}
          repeat={playback.status.repeat}
          shuffle={playback.status.shuffle}
          onToggle={togglePlayback}
          onNext={playback.next}
          onPrevious={playback.previous}
          onSeek={playback.seek}
          onVolume={playback.setVolume}
          onToggleEq={() => setEqOpen((open) => !open)}
          onToggleQueue={() => setQueueSheetOpen((open) => !open)}
          onCycleRepeat={() => playback.cycleRepeat()}
          onToggleShuffle={() => playback.toggleShuffle()}
        />
      </div>
      {autoTag && (
        <AutoTagDialog
          files={autoTagFilesOf(autoTag.tracks)}
          skipped={autoTag.skipped}
          initialQuery={autoTag.initialQuery}
          onClose={() => setAutoTag(null)}
        />
      )}
    </div>
  )
}