import { useEffect, useRef, useState } from 'react'
import type { Artist, Track } from '@shared/types'
import { formatCount, formatDuration } from '../format'
import { albumsForArtist, coverPathForAlbum, type LibraryIndex, type Selection } from './view'
import { CoverArt } from './CoverArt'

/** Last path segment, handling both separators since the renderer has no node:path. */
function folderLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

export interface SidebarProps {
  readonly index: LibraryIndex
  readonly artists: readonly Artist[]
  readonly selection: Selection
  readonly albumCount: number
  readonly trackCount: number
  readonly missingRoots: readonly string[]
  readonly queue: readonly Track[]
  readonly currentIndex: number
  readonly playing: boolean
  readonly query: string
  readonly navOpen: boolean
  onSelect(selection: Selection): void
  onRemoveRoot(path: string): void
  onPlayAt(queueIndex: number): void
  onRemoveAt(queueIndex: number): void
}

/**
 * Spotify-style navigation rail. Each artist borrows the artwork of its first
 * album as a stand-in for artist imagery, which the library format does not carry.
 */
export function Sidebar({
  index,
  artists,
  selection,
  albumCount,
  trackCount,
  missingRoots,
  queue,
  currentIndex,
  playing,
  onSelect,
  onRemoveRoot,
  onPlayAt,
  onRemoveAt,
  query,
  navOpen
}: SidebarProps) {
  const [queueOpen, setQueueOpen] = useState(false)
  // Reveal the queue the first time something lands in it, so queueing from a
  // collapsed panel still gives visible feedback.
  const prevQueueLength = useRef(queue.length)
  useEffect(() => {
    if (prevQueueLength.current === 0 && queue.length > 0) setQueueOpen(true)
    prevQueueLength.current = queue.length
  }, [queue.length])
  const activeArtist = selection.kind === 'artist' ? selection.artist : null
  const activeAlbumKey = selection.kind === 'album' ? selection.albumKey : null
  const listRef = useRef<HTMLOListElement | null>(null)
  // Chronological queue with the view scrolled to what's playing on expand,
  // so played tracks sit on top and the current track is still visible.
  useEffect(() => {
    if (!queueOpen) return
    const list = listRef.current
    const active = list?.querySelector('.queue-side-row.active') as HTMLElement | null
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const rowRect = active.getBoundingClientRect()
    list.scrollTop += rowRect.top - listRect.top - list.clientHeight / 2 + rowRect.height / 2
  }, [queueOpen])

  return (
    <aside className={navOpen ? 'sidebar open' : 'sidebar'}>
      {/* <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Onda</span>
      </div> */}

      <nav aria-label="Library">
        <p className="nav-label">Browse</p>
        <button
          type="button"
          className={selection.kind === 'all' ? 'nav-item active' : 'nav-item'}
          onClick={() => onSelect({ kind: 'all' })}
        >
          <span className="nav-icon" aria-hidden="true">
            ▦
          </span>
          All albums
        </button>

        <p className="nav-label">Artists</p>
        {artists.length === 0 && (
          <p className="nav-empty">
            {query.trim() === '' ? 'Nothing scanned yet' : 'No artists match'}
          </p>
        )}
        {artists.map((artist) => {
          const first = albumsForArtist(index, artist.name)[0]
          const isActive =
            activeArtist === artist.name ||
            (first !== undefined && activeAlbumKey === first.key)
          return (
            <button
              key={artist.name}
              type="button"
              className={isActive ? 'nav-item active' : 'nav-item'}
              onClick={() => onSelect({ kind: 'artist', artist: artist.name })}
              title={artist.name}
            >
              <CoverArt path={coverPathForAlbum(first)} size={28} alt="" rounded />
              <span className="nav-text">{artist.name}</span>
            </button>
          )
        })}
      </nav>

      <section className="queue-side" aria-label="Playback queue">
        <button
          type="button"
          className="queue-side-head"
          onClick={() => setQueueOpen((open) => !open)}
          aria-expanded={queueOpen}
          aria-label={queueOpen ? 'Collapse queue' : 'Expand queue'}
        >
          <span className="nav-label queue-side-label">
            Queue{queue.length > 0 ? ` · ${queue.length}` : ''}
          </span>
          <span className="queue-chevron" aria-hidden="true">
            {queueOpen ? '▾' : '▸'}
          </span>
        </button>
        {queueOpen &&
          (queue.length === 0 ? (
            <p className="nav-empty">Nothing queued yet</p>
          ) : (
            <ol ref={listRef} className="queue-side-list">
              {queue.map((track, listIndex) => {
                const active = listIndex === currentIndex
                const wasPlayed = listIndex < currentIndex
                return (
                  <li
                    key={`${track.path}#${listIndex}`}
                    className={
                      active
                        ? 'queue-side-row active'
                        : wasPlayed
                          ? 'queue-side-row played'
                          : 'queue-side-row'
                    }
                  >
                    <button
                      type="button"
                      className="queue-side-play"
                      onClick={() => onPlayAt(listIndex)}
                      aria-label={wasPlayed ? `Replay ${track.title}` : `Play ${track.title}`}
                      title={`${track.title} — ${track.artist || 'Unknown artist'}`}
                    >
                      <span className="queue-side-title">{track.title}</span>
                      <span className="queue-side-meta">
                        {active && playing ? '❙❙ ' : ''}
                        {track.artist || 'Unknown artist'} · {formatDuration(track.durationSec)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="ghost queue-side-remove"
                      onClick={() => onRemoveAt(listIndex)}
                      aria-label={`Remove ${track.title} from queue`}
                      title="Remove from queue"
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ol>
          ))}
      </section>

      <div className="sidebar-foot">
        {missingRoots.length > 0 && (
          <div className="missing-roots" role="status">
            <p className="missing-title">
              {missingRoots.length === 1
                ? '1 folder unavailable'
                : `${missingRoots.length} folders unavailable`}
            </p>
            {missingRoots.map((path) => (
              <div key={path} className="missing-row">
                <span className="missing-path" title={path}>
                  {folderLabel(path) || path}
                </span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => onRemoveRoot(path)}
                  aria-label={`Forget ${path}`}
                  title="Forget this folder"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="library-counts">
          {formatCount(albumCount, 'album')} · {formatCount(trackCount, 'track')}
        </p>
        {albumCount === 0 && (
          <p className="library-hint">No music yet — add folders from Settings ⚙ above.</p>
        )}
      </div>
    </aside>
  )
}