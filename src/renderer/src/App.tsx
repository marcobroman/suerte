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
import { Sidebar } from './library/Sidebar'
import { SortControl } from './library/SortControl'
import { applyTheme, resolveTheme, THEME_OPTIONS } from './library/themes'
import { autoTagFilesOf, buildAutoTagQuery } from './library/autotag'
import { eqPresetById } from './library/eqPresets'
import { defaultEqSettings, normalizeEqSettings } from './audio/settings'
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
import { usePlaybackEngine } from './usePlaybackEngine'

export function App() {
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
  const [sortKey, setSortKey] = useState<AlbumSortKey>('artist')
  const [sortDir, setSortDir] = useState<AlbumSortDir>('asc')
  const [autoTag, setAutoTag] = useState<{
    tracks: readonly Track[]
    skipped: number
    initialQuery: string
  } | null>(null)
  const [eqOpen, setEqOpen] = useState(false)
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

  const playback = usePlaybackEngine()
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  useEffect(() => {
    const unsubscribeProgress = window.equalizer.onScanProgress((progress) => {
      setScanStatus(
        progress.total > 0 ? `scanning ${progress.scanned}/${progress.total}` : 'scanning'
      )
    })
    // Main can rescan on its own, for instance when the window regains focus.
    const unsubscribeLibrary = window.equalizer.onLibraryChanged((next) => {
      setSummary(next)
      setScanStatus('library updated')
    })
    void window.equalizer
      .getLibrary()
      .then((next) => {
        setSummary(next)
        if (next.roots.length > 0) setScanStatus('ready')
      })
      .catch((error: unknown) => setScanStatus(`error: ${String(error)}`))
    return () => {
      unsubscribeProgress()
      unsubscribeLibrary()
    }
  }, [])

  useEffect(() => {
    void window.equalizer
      .getSettings()
      .then((settings) => {
        const resolved = resolveTheme(settings.theme)
        applyTheme(resolved, document.documentElement)
        setThemeState(resolved)
        setDiscogsTokenSet(settings.discogsTokenSet)
        if (settings.eq) {
          playbackRef.current.setEq({
            ...normalizeEqSettings(settings.eq),
            masterVolume: playbackRef.current.status.volume
          })
        }
        setSettingsLoaded(true)
      })
      .catch(() => undefined)
  }, [])

  const saveToken = useCallback(() => {
    setTokenBusy(true)
    setTokenMessage('')
    void window.equalizer
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
  }, [tokenDraft])

  const clearToken = useCallback(() => {
    setTokenBusy(true)
    setTokenMessage('')
    void window.equalizer
      .setDiscogsToken('')
      .then(
        (settings) => {
          setDiscogsTokenSet(settings.discogsTokenSet)
          setTokenMessage('Token cleared.')
        },
        () => setTokenMessage('Could not clear the token.')
      )
      .finally(() => setTokenBusy(false))
  }, [])

  const changeTheme = useCallback((next: ThemeId) => {
    // Applied immediately; main confirms and persists it.
    applyTheme(next, document.documentElement)
    setThemeState(next)
    void window.equalizer.setTheme(next).then(
      (settings) => setThemeState(resolveTheme(settings.theme)),
      () => setScanStatus('could not save theme')
    )
  }, [])

  const select = useCallback(
    (next: Selection) => {
      setHistory((entries) => [...entries.slice(0, cursor + 1), next])
      setCursor((value) => value + 1)
    },
    [cursor]
  )

  const openAlbum = useCallback((album: Album) => select(selectionForAlbum(album)), [select])

  const chooseFolders = useCallback(() => {
    setBusy(true)
    setScanStatus('choosing folders')
    void (async () => {
      try {
        const picked = await window.equalizer.pickFolders()
        if (picked.length === 0) {
          setScanStatus('cancelled')
          return
        }
        setScanStatus('scanning')
        const result = await window.equalizer.scanLibrary()
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
  }, [])

  const removeRoot = useCallback((path: string) => {
    setScanStatus('forgetting folder')
    void window.equalizer
      .removeRoot(path)
      .then((next) => {
        setSummary(next)
        setScanStatus('folder removed')
      })
      .catch((error: unknown) => setScanStatus(`error: ${String(error)}`))
  }, [])

  const reveal = useCallback((path: string) => {
    void window.equalizer.revealInExplorer(path)
  }, [])

  const playArtist = useCallback(() => {
    if (view.tracks.length === 0) return
    playback.playQueue(view.tracks, 0)
  }, [view.tracks, playback])

  const playAlbum = useCallback(
    (album: Album) => {
      const tracks = tracksForAlbum(index, album)
      if (tracks.length === 0) return
      playback.playQueue(tracks, 0)
    },
    [index, playback]
  )

  const queueAlbumNext = useCallback(
    (album: Album) => {
      const tracks = tracksForAlbum(index, album)
      if (tracks.length === 0) return
      playback.addNext(tracks)
    },
    [index, playback]
  )

  const queueAlbumLast = useCallback(
    (album: Album) => {
      const tracks = tracksForAlbum(index, album)
      if (tracks.length === 0) return
      playback.addLast(tracks)
    },
    [index, playback]
  )

  const playTrackAt = useCallback(
    (trackIndex: number) => {
      if (view.tracks.length === 0) return
      playback.playQueue(view.tracks, trackIndex)
    },
    [view.tracks, playback]
  )

  const playAllVisible = useCallback(() => {
    if (view.tracks.length === 0) return
    playback.playQueue(view.tracks, 0)
  }, [view.tracks, playback])

  const queueTrackNext = useCallback(
    (trackIndex: number) => {
      const track = view.tracks[trackIndex]
      if (!track) return
      playback.addNext([track])
    },
    [view.tracks, playback]
  )

  const queueTrackLast = useCallback(
    (trackIndex: number) => {
      const track = view.tracks[trackIndex]
      if (!track) return
      playback.addLast([track])
    },
    [view.tracks, playback]
  )

  const queueVisibleNext = useCallback(() => {
    if (view.tracks.length === 0) return
    playback.addNext([...view.tracks])
  }, [view.tracks, playback])

  const queueVisibleLast = useCallback(() => {
    if (view.tracks.length === 0) return
    playback.addLast([...view.tracks])
  }, [view.tracks, playback])

  const openAutoTagTracks = useCallback((tracks: readonly Track[]) => {
    const writable = tracks.filter((track) => extensionOf(track.path) === '.mp3')
    setAutoTag({
      tracks: writable,
      skipped: tracks.length - writable.length,
      initialQuery: buildAutoTagQuery(autoTagFilesOf(tracks))
    })
  }, [])

  const autoTagVisibleAlbum = useCallback(() => {
    if (view.tracks.length === 0) return
    openAutoTagTracks(view.tracks)
  }, [view.tracks, openAutoTagTracks])

  const autoTagVisibleTrack = useCallback(
    (trackIndex: number) => {
      const track = view.tracks[trackIndex]
      if (!track) return
      openAutoTagTracks([track])
    },
    [view.tracks, openAutoTagTracks]
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
      void window.equalizer.setEqSettings(persisted).then(
        () => {
          lastSavedEq.current = key
        },
        () => undefined
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [settingsLoaded, playback.status.eq])

  const openSearchAlbum = useCallback(
    (album: Album) => {
      setQuery('')
      openAlbum(album)
    },
    [openAlbum]
  )

  const playSearchTracks = useCallback(() => {
    if (searchTracks.length === 0) return
    playback.playQueue(searchTracks, 0)
  }, [searchTracks, playback])

  const playSearchTrackAt = useCallback(
    (trackIndex: number) => {
      // A results list is a grab-bag, not a listening context, so a click plays
      // just that track. Bulk actions (Play all, queue menus) cover the rest.
      const track = searchTracks[trackIndex]
      if (!track) return
      playback.playQueue([track], 0)
    },
    [searchTracks, playback]
  )

  const queueSearchTrackNext = useCallback(
    (trackIndex: number) => {
      const track = searchTracks[trackIndex]
      if (!track) return
      playback.addNext([track])
    },
    [searchTracks, playback]
  )

  const queueSearchTrackLast = useCallback(
    (trackIndex: number) => {
      const track = searchTracks[trackIndex]
      if (!track) return
      playback.addLast([track])
    },
    [searchTracks, playback]
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
        <Sidebar
          index={index}
          artists={view.artists}
          selection={selection}
          albumCount={index.tree.albums.length}
          trackCount={summary?.trackCount ?? 0}
          missingRoots={summary?.missingRoots ?? []}
          queue={playback.status.queue}
          currentIndex={playback.status.index}
          playing={playback.status.state === 'playing'}
          query={query}
          onSelect={select}
          onRemoveRoot={removeRoot}
          onPlayAt={(queueIndex) => void playback.playAt(queueIndex)}
          onRemoveAt={(queueIndex) => playback.removeAt(queueIndex)}
        />

        <main className="main">
          <header className="topbar">
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
                    <p className="settings-label">Theme</p>
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={option.id === theme}
                        className={
                          option.id === theme ? 'settings-item active' : 'settings-item'
                        }
                        onClick={() => {
                          changeTheme(option.id)
                          setSettingsOpen(false)
                        }}
                      >
                        <span className="swatch-colors small" aria-hidden="true">
                          {option.swatches.map((color) => (
                            <span key={color} style={{ background: color }} />
                          ))}
                        </span>
                        {option.label}
                      </button>
                    ))}
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
                                { label: 'Show in Explorer', onSelect: () => reveal(track.path) }
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
        <NowPlayingBar
          track={playback.status.track}
          state={playback.status.state}
          positionSec={playback.positionSec}
          durationSec={playback.status.durationSec}
          volume={playback.status.volume}
          canPlay={canPlay}
          eqOpen={eqOpen}
          repeat={playback.status.repeat}
          shuffle={playback.status.shuffle}
          onToggle={togglePlayback}
          onNext={playback.next}
          onPrevious={playback.previous}
          onSeek={playback.seek}
          onVolume={playback.setVolume}
          onToggleEq={() => setEqOpen((open) => !open)}
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