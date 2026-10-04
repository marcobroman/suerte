import type { Track } from '@shared/types'
import type { EngineStatus } from '../audio/engine'
import { formatDuration } from '../format'
import { Slider } from '../Slider'
import { CoverArt } from './CoverArt'

export interface NowPlayingBarProps {
  readonly track: Track | null
  readonly state: EngineStatus['state']
  readonly positionSec: number
  readonly durationSec: number
  readonly volume: number
  readonly canPlay: boolean
  onToggle(): void
  onNext(): void
  onPrevious(): void
  onSeek(seconds: number): void
  onVolume(volume: number): void
}

/**
 * Persistent transport strip. The seek bar reports its own duration so it never
 * disagrees with the row that asked for the track.
 */
export function NowPlayingBar({
  track,
  state,
  positionSec,
  durationSec,
  volume,
  canPlay,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onVolume
}: NowPlayingBarProps) {
  const playing = state === 'playing'
  const loading = state === 'loading'
  const duration = durationSec > 0 ? durationSec : (track?.durationSec ?? 0)

  return (
    <footer className="player">
      <div className="player-now">
        <CoverArt path={track?.path ?? null} size={56} alt="" rounded />
        <div className="now-text">
          <span className="now-title">{track?.title ?? 'Nothing playing'}</span>
          <span className="now-artist">{track?.artist || 'Unknown artist'}</span>
        </div>
      </div>

      <div className="player-center">
        <div className="transport">
          <button type="button" onClick={onPrevious} disabled={!canPlay} aria-label="Previous">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M7 6v12H5V6h2zm12 0v12l-9-6 9-6z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="transport-play"
            onClick={onToggle}
            disabled={!canPlay}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {loading ? (
              <span className="spinner" />
            ) : playing ? (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M8 5v14l11-7z" fill="currentColor" />
              </svg>
            )}
          </button>
          <button type="button" onClick={onNext} disabled={!canPlay} aria-label="Next">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M17 6v12h2V6h-2zM5 6v12l9-6-9-6z" fill="currentColor" />
            </svg>
          </button>
        </div>

        <div className="progress">
          <span className="time">{formatDuration(positionSec)}</span>
          <Slider
            value={positionSec}
            max={Math.max(duration, 0.01)}
            step={0.25}
            label="Seek"
            onChange={onSeek}
          />
          <span className="time">{formatDuration(duration)}</span>
        </div>
      </div>

      <div className="player-volume">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"
            fill="currentColor"
          />
        </svg>
        <Slider value={volume} max={1} step={0.01} label="Volume" onChange={onVolume} />
      </div>

      {state === 'error' && <p className="player-error">Playback failed</p>}
    </footer>
  )
}