import type { CSSProperties } from 'react'

export interface SliderProps {
  readonly value: number
  readonly min?: number
  readonly max: number
  readonly step?: number
  readonly label: string
  onChange(value: number): void
}

/**
 * A range input whose filled portion is painted with a gradient. A native range
 * cannot show progress on its own, and the seek bar needs the same look as volume.
 */
export function Slider({ value, min = 0, max, step = 0.01, label, onChange }: SliderProps) {
  const span = max - min
  const ratio = span > 0 ? Math.min(Math.max((value - min) / span, 0), 1) : 0
  const fill = { '--fill': `${ratio * 100}%` } as CSSProperties

  return (
    <input
      type="range"
      className="slider"
      style={fill}
      min={min}
      max={max}
      step={step}
      value={Math.min(Math.max(value, min), max)}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label={label}
    />
  )
}