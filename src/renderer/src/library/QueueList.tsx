import { memo, useEffect, useRef } from 'react'
import type { Track } from '@shared/types'
import { formatDuration } from '../format'

export interface QueueListProps {
  readonly queue: readonly Track[]
  readonly currentIndex: number
  readonly playing: boolean
  onPlayAt(queueIndex: number): void
  onRemoveAt(queueIndex: number): void
}

/**
 * Chronological queue with played tracks dimmed. Mounts scrolled to what's
 * playing, so the current track is visible without yanking the scroll while
 * browsing. Shared by the sidebar rail and the pull-up sheet.
 */
export function QueueList({ queue, currentIndex, playing, onPlayAt, onRemoveAt }: QueueListProps) {
  const listRef = useRef<HTMLOListElement | null>(null)

  useEffect(() => {
    const list = listRef.current
    const active = list?.querySelector('.queue-side-row.active') as HTMLElement | null
    if (!list || !active) return
    const listRect = list.getBoundingClientRect()
    const rowRect = active.getBoundingClientRect()
    list.scrollTop += rowRect.top - listRect.top - list.clientHeight / 2 + rowRect.height / 2
  }, [])

  if (queue.length === 0) {
    return <p className="nav-empty">Nothing queued yet</p>
  }

  return (
    <ol ref={listRef} className="queue-side-list">
      {queue.map((track, listIndex) => (
        <QueueRow
          key={`${track.path}#${listIndex}`}
          track={track}
          active={listIndex === currentIndex}
          wasPlayed={listIndex < currentIndex}
          showPause={listIndex === currentIndex && playing}
          onPlayAt={onPlayAt}
          onRemoveAt={onRemoveAt}
          listIndex={listIndex}
        />
      ))}
    </ol>
  )
}

interface QueueRowProps {
  readonly track: Track
  readonly active: boolean
  readonly wasPlayed: boolean
  readonly showPause: boolean
  readonly listIndex: number
  onPlayAt(queueIndex: number): void
  onRemoveAt(queueIndex: number): void
}

/**
 * One row, memoized: the queue array is now shared by reference across
 * emits, and the stable action callbacks below mean only rows whose own
 * props change re-render (no more full-list reconcile on EQ-only emits).
 */
const QueueRow = memo(function QueueRow({
  track,
  active,
  wasPlayed,
  showPause,
  listIndex,
  onPlayAt,
  onRemoveAt
}: QueueRowProps) {
  return (
    <li
      className={
        active ? 'queue-side-row active' : wasPlayed ? 'queue-side-row played' : 'queue-side-row'
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
          {showPause ? '❙❙ ' : ''}
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
})
