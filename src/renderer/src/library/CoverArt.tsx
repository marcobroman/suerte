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
 * One shared observer for every tile instead of one per tile: same 250px
 * pre-load margin and same fire-once semantics, without O(tiles) observers.
 * Module state is a plain element→callback map; StrictMode remounts simply
 * re-observe through the effect cleanup below.
 */
type VisibilityCallback = () => void
const watched = new Map<Element, VisibilityCallback>()
let sharedObserver: IntersectionObserver | null = null

function observeVisibility(node: Element, onVisible: VisibilityCallback): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible()
    return () => undefined
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const show = watched.get(entry.target)
          if (show) {
            watched.delete(entry.target)
            sharedObserver?.unobserve(entry.target)
            show()
          }
        }
      },
      { rootMargin: '250px' }
    )
  }
  const observer = sharedObserver
  watched.set(node, onVisible)
  observer.observe(node)
  return () => {
    watched.delete(node)
    observer.unobserve(node)
  }
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
    return observeVisibility(node, () => setVisible(true))
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
