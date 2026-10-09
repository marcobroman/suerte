import type { Artist } from '@shared/types'
import { formatCount } from '../format'
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
  readonly query: string
  readonly navOpen: boolean
  /** Phone client: folder management stays hidden. */
  readonly phone: boolean
  /** Fired when an artist image fails (lets the phone probe a dead credential). */
  readonly onCoverError?: () => void
  onSelect(selection: Selection): void
  onRemoveRoot(path: string): void
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
  onSelect,
  onRemoveRoot,
  query,
  navOpen,
  phone,
  onCoverError
}: SidebarProps) {
  const activeArtist = selection.kind === 'artist' ? selection.artist : null
  const activeAlbumKey = selection.kind === 'album' ? selection.albumKey : null

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
              <CoverArt path={coverPathForAlbum(first)} size={28} alt="" rounded onError={onCoverError} />
              <span className="nav-text">{artist.name}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-foot">
        {!phone && missingRoots.length > 0 && (
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