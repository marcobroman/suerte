import type { Track } from '@shared/types'
import type { EngineStatus, RepeatMode } from '../audio/engine'
import { formatDuration } from '../format'
import { Slider } from '../Slider'
import { CoverArt } from './CoverArt'

const REPEAT_LABELS: Record<RepeatMode, string> = {
  off: 'Repeat off',
  all: 'Repeat all',
  one: 'Repeat one'
}

export interface NowPlayingBarProps {
  readonly track: Track | null
  readonly state: EngineStatus['state']
  readonly positionSec: number
  readonly durationSec: number
  readonly volume: number
  readonly canPlay: boolean
  readonly eqOpen: boolean
  readonly repeat: RepeatMode
  readonly shuffle: boolean
  /** Phone client: hardware buttons own the volume, so the slider hides. */
  readonly phone: boolean
  /** Fired when the now-playing image fails (lets the phone probe a dead credential). */
  readonly onCoverError?: () => void
  readonly queueOpen: boolean
  onToggle(): void
  onNext(): void
  onPrevious(): void
  onSeek(seconds: number): void
  onVolume(volume: number): void
  onToggleEq(): void
  onCycleRepeat(): void
  onToggleShuffle(): void
  onToggleQueue(): void
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
  eqOpen,
  repeat,
  shuffle,
  phone,
  queueOpen,
  onCoverError,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onVolume,
  onToggleEq,
  onCycleRepeat,
  onToggleShuffle,
  onToggleQueue
}: NowPlayingBarProps) {
  const playing = state === 'playing'
  const loading = state === 'loading'
  const duration = durationSec > 0 ? durationSec : (track?.durationSec ?? 0)

  return (
    <footer className="player">
      <div className="player-now">
        <CoverArt path={track?.path ?? null} size={56} alt="" rounded onError={onCoverError} />
        <div className="now-text">
          <span className="now-title">{track?.title ?? 'Nothing playing'}</span>
          <span className="now-artist">{track?.artist || 'Unknown artist'}</span>
        </div>
        <button
          type="button"
          className={queueOpen ? 'icon-toggle queue-inline active' : 'icon-toggle queue-inline'}
          onClick={onToggleQueue}
          aria-label={queueOpen ? 'Hide queue' : 'Show queue'}
          aria-expanded={queueOpen}
          title="Queue"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M4 6h12v2H4zm0 5h12v2H4zm0 5h8v2H4zm13-1 4-4v8z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      <div className="player-center">
        <div className="transport">
          <button
            type="button"
            className={shuffle ? 'icon-toggle transport-small active' : 'icon-toggle transport-small'}
            onClick={onToggleShuffle}
            disabled={!canPlay}
            aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-pressed={shuffle}
            title="Shuffle"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
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
          <button
            type="button"
            className={
              repeat === 'off' ? 'icon-toggle transport-small' : 'icon-toggle transport-small active'
            }
            onClick={onCycleRepeat}
            disabled={!canPlay}
            aria-label={REPEAT_LABELS[repeat]}
            title={REPEAT_LABELS[repeat]}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {repeat === 'one' && (
              <span className="transport-badge" aria-hidden="true">
                1
              </span>
            )}
          </button>
          <button
            type="button"
            className={
              eqOpen ? 'icon-toggle transport-small active' : 'icon-toggle transport-small'
            }
            onClick={onToggleEq}
            aria-label={eqOpen ? 'Hide equalizer' : 'Show equalizer'}
            aria-expanded={eqOpen}
            title="Equalizer"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M4 6h10v2H4zm0 5h16v2H4zm0 5h10v2H4zM17 8l5 3-5 3z"
                fill="currentColor"
              />
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

      {!phone && (
        <div className="player-volume">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"
              fill="currentColor"
            />
          </svg>
          <Slider value={volume} max={1} step={0.01} label="Volume" onChange={onVolume} />
        </div>
      )}

      {state === 'error' && <p className="player-error">Playback failed</p>}
    </footer>
  )
}