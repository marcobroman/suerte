import { useEffect, useState } from 'react'

/**
 * Temporary debug readout for layout reports: viewport size, which breakpoint
 * is active, and whether the player footer is actually visible on screen.
 */
export function ViewportDebug() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [playerVisible, setPlayerVisible] = useState(true)

  useEffect(() => {
    const onResize = (): void => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const player = document.querySelector('footer.player')
    if (!player) return
    const observer = new IntersectionObserver(
      (entries) => setPlayerVisible(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.5 }
    )
    observer.observe(player)
    return () => observer.disconnect()
  }, [])

  const breakpoint = size.width <= 640 ? 'xs' : size.width <= 768 ? 'mobile' : 'desktop'
  return (
    <div className="viewport-debug" aria-hidden="true">
      {size.width}×{size.height} · {breakpoint} · player {playerVisible ? 'visible' : 'HIDDEN'}
    </div>
  )
}
