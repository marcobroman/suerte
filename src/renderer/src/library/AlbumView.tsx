import type { Album, Track } from '@shared/types'
import { formatDuration } from '../format'
import { CoverArt } from './CoverArt'
import { OverflowMenu } from './OverflowMenu'
import { coverPathForAlbum } from './view'

export interface AlbumViewProps {
  readonly album: Album
  readonly tracks: readonly Track[]
  readonly query: string
  readonly currentPath: string | null
  readonly playing: boolean
  /** Phone client: desktop-only actions stay hidden. */
  readonly phone: boolean
  /** Fired when the hero image fails (lets the phone probe a dead credential). */
  readonly onCoverError?: () => void
  onPlay(index: number): void
  onPlayAll(): void
  onAddNext(index: number): void
  onAddLast(index: number): void
  onQueueAlbumNext(): void
  onQueueAlbumLast(): void
  onAutoTagAlbum(): void
  onAutoTagTrack(index: number): void
  onReveal(path: string): void
}

/** Album page: large artwork, metadata header, and the track listing. */
export function AlbumView({
  album,
  tracks,
  query,
  currentPath,
  playing,
  phone,
  onCoverError,
  onPlay,
  onPlayAll,
  onAddNext,
  onAddLast,
  onQueueAlbumNext,
  onQueueAlbumLast,
  onAutoTagAlbum,
  onAutoTagTrack,
  onReveal
}: AlbumViewProps) {
  const totalSec = tracks.reduce((sum, track) => sum + track.durationSec, 0)

  return (
    <div className="album-view">
      <header className="album-hero">
        <CoverArt path={coverPathForAlbum(album)} size={176} alt={`${album.title} cover`} eager onError={onCoverError} />
        <div className="album-hero-text">
          <p className="album-eyebrow">Album</p>
          <h1>{album.title}</h1>
          <p className="album-facts">
            <span>{album.artist}</span>
            {album.year !== null && (
              <>
                <span className="dot">·</span>
                <span>{album.year}</span>
              </>
            )}
            <span className="dot">·</span>
            <span>
              {tracks.length} {tracks.length === 1 ? 'track' : 'tracks'}
            </span>
            <span className="dot">·</span>
            <span>{formatDuration(totalSec)}</span>
          </p>
          <div className="album-actions">
            <button type="button" className="primary-button" onClick={onPlayAll}>
              ▶ Play
            </button>
            <button type="button" className="ghost-button" onClick={onQueueAlbumNext}>
              Play next
            </button>
            <button type="button" className="ghost-button" onClick={onQueueAlbumLast}>
              + Queue
            </button>
            {!phone && (
              <button type="button" className="ghost-button" onClick={onAutoTagAlbum}>
                Auto-tag
              </button>
            )}
          </div>
        </div>
      </header>

      <ol className="tracklist">
        {tracks.length === 0 && query.trim() !== '' && (
          <li>
            <p className="empty">No tracks match your search.</p>
          </li>
        )}
        {tracks.map((track, index) => {
          const active = track.path === currentPath
          return (
            <li key={track.path} className={active ? 'track active' : 'track'}>
              {/*
                One button per row, stretched over the whole row by a pseudo-element
                so the text is clickable too. The reveal button sits above it.
              */}
              <button
                type="button"
                className="track-play"
                onClick={() => onPlay(index)}
                aria-label={`Play ${track.title}`}
              >
                <span className="track-number">{index + 1}</span>
                <span className="track-playicon">{active && playing ? '❙❙' : '▶'}</span>
              </button>
              <span className="track-title">{track.title}</span>
              <span className="track-duration">{formatDuration(track.durationSec)}</span>
              <OverflowMenu
                ariaLabel={`More actions for ${track.title}`}
                className="track-more"
                items={[
                  { label: 'Play', onSelect: () => onPlay(index) },
                  { label: 'Play next', onSelect: () => onAddNext(index) },
                  { label: 'Add to queue', onSelect: () => onAddLast(index) },
                  ...(!phone
                    ? [
                        { label: 'Auto-tag…', onSelect: () => onAutoTagTrack(index) },
                        { label: 'Show in Explorer', onSelect: () => onReveal(track.path) }
                      ]
                    : [])
                ]}
              />
            </li>
          )
        })}
      </ol>
    </div>
  )
}