import { useEffect, useRef, useState } from 'react'
import { useCover } from './covers'
import { useCoverStore } from './coverStore'

export interface CoverArtProps {
  readonly path: string | null
  readonly size: number
  readonly alt?: string
  readonly rounded?: boolean
  /** Loads immediately instead of waiting for the element to scroll into view. */
  readonly eager?: boolean
  /** Lets CSS size the tile, for responsive grids instead of a fixed square. */
  readonly fill?: boolean
  /**
   * Fired when the image fails to load. Tags report no status, so callers
   * that can tell auth-death from a missing file (the phone backend's
   * auth probe) pass it here; everyone else omits it.
   */
  readonly onError?: () => void
}

/**
 * Artwork is only fetched once the tile is near the viewport. A large library has
 * hundreds of albums, and each miss re-parses metadata in the main process.
 */
export function CoverArt({
  path,
  size,
  alt = '',
  rounded = false,
  eager = false,
  fill = false,
  onError
}: CoverArtProps) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(eager)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [path])

  useEffect(() => {
    if (eager) {
      setVisible(true)
      return
    }
    const node = ref.current
    if (!node) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisible(true)
        observer.disconnect()
      },
      { rootMargin: '250px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [eager])

  const url = useCover(useCoverStore(), visible ? path : null)
  const shape = rounded ? '50%' : '4px'
  const box = fill ? undefined : { width: size, height: size }
  const classes = ['cover']
  if (fill) classes.push('cover-fill')
  // A resolvable URL can still fail (remote covers, dead credentials); fall
  // back instead of showing a broken image. Reset per path so stale failures
  // never stick. Auth-death is reported out for backends that can route it.
  const art = url && !failed ? url : null
  if (art) classes.push('has-art')
  const handleError = (): void => {
    setFailed(true)
    onError?.()
  }

  return (
    <div
      ref={ref}
      className={classes.join(' ')}
      style={{ ...box, borderRadius: shape }}
      aria-hidden={art ? undefined : true}
    >
      {art ? (
        <img
          src={art}
          alt={alt}
          onError={handleError}
          {...(fill ? {} : { width: size, height: size })}
        />
      ) : (
        <span className="cover-fallback" />
      )}
    </div>
  )
}
