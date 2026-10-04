import type { Album } from '@shared/types'
import { CoverArt } from './CoverArt'
import { OverflowMenu } from './OverflowMenu'
import { coverPathForAlbum } from './view'

export interface AlbumGridProps {
  readonly albums: readonly Album[]
  readonly query: string
  onOpen(album: Album): void
  onPlay(album: Album): void
  onQueueNext(album: Album): void
  onQueueLast(album: Album): void
  onAutoTag(album: Album): void
}

/** Card grid of album tiles, the shape a music library is normally browsed in. */
export function AlbumGrid({ albums, query, onOpen, onPlay, onQueueNext, onQueueLast, onAutoTag }: AlbumGridProps) {
  if (albums.length === 0) {
    return (
      <p className="empty">
        {query.trim() === ''
          ? 'Nothing here yet. Add music folders from Settings ⚙.'
          : 'No albums match your search.'}
      </p>
    )
  }

  return (
    <ul className="album-grid">
      {albums.map((album) => (
        <li key={album.key}>
          <div className="album-card">
            {/* Art and text are one button, so the whole tile opens the album. */}
            <button
              type="button"
              className="card-open"
              onClick={() => onOpen(album)}
              aria-label={`Open ${album.title}`}
            >
              <span className="card-art">
                <CoverArt path={coverPathForAlbum(album)} size={0} alt="" fill />
              </span>
              <span className="card-title">{album.title}</span>
              <span className="card-sub">
                {album.year ?? '—'} · {album.trackPaths.length}{' '}
                {album.trackPaths.length === 1 ? 'track' : 'tracks'}
              </span>
            </button>
            <button
              type="button"
              className="card-play"
              onClick={() => onPlay(album)}
              aria-label={`Play ${album.title}`}
              title="Play"
            >
              ▶
            </button>
            <OverflowMenu
              ariaLabel={`More actions for ${album.title}`}
              className="card-more"
              items={[
                { label: 'Play', onSelect: () => onPlay(album) },
                { label: 'Play next', onSelect: () => onQueueNext(album) },
                { label: 'Add to queue', onSelect: () => onQueueLast(album) }
              ]}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}