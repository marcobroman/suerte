import { useEffect, useMemo, useRef, useState } from 'react'
import type { EqSettings } from '@shared/types'
import { BAND_GAIN_MAX_DB, BAND_GAIN_MIN_DB, formatDb } from '../audio/db'
import { BANDS } from '../audio/bands'
import {
  CURVE_PAD_LEFT,
  CURVE_PAD_RIGHT,
  EQ_CURVE_MIN_HZ,
  createCurveScale,
  eqCurveDb,
  smoothPath,
  type CurvePoint
} from './eqCurve'

const PLOT_HEIGHT = 170

export interface EqCurvePlotProps {
  readonly eq: EqSettings
  onBandGain(index: number, gainDb: number): void
  onBandReset(index: number): void
}

/**
 * Live response plot that doubles as the control surface: each band is a node
 * on the curve, dragged vertically to set its gain. Keyboard users get the
 * same control through arrow keys on focused nodes.
 */
export function EqCurvePlot({ eq, onBandGain, onBandReset }: EqCurvePlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragIndex = useRef<number | null>(null)
  const [plotWidth, setPlotWidth] = useState(600)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  useEffect(() => {
    const node = wrapRef.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) setPlotWidth(Math.max(200, Math.round(width)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const scale = useMemo(() => createCurveScale(plotWidth, PLOT_HEIGHT), [plotWidth])

  const path = useMemo(() => {
    const { frequenciesHz, magnitudesDb } = eqCurveDb(eq)
    const points: CurvePoint[] = []
    for (let index = 0; index < frequenciesHz.length; index++) {
      points.push({
        x: scale.xForHz(frequenciesHz[index] ?? EQ_CURVE_MIN_HZ),
        y: scale.yForDb(magnitudesDb[index] ?? 0)
      })
    }
    return smoothPath(points)
  }, [eq, scale])

  const gainForClientY = (clientY: number): number => {
    const svg = svgRef.current
    if (!svg) return 0
    const rect = svg.getBoundingClientRect()
    // The viewBox matches measured pixels, so this maps 1:1.
    const y = ((clientY - rect.top) / Math.max(1, rect.height)) * PLOT_HEIGHT
    return Math.round(scale.dbForY(y) * 2) / 2
  }

  const stopDrag = (): void => {
    dragIndex.current = null
    setActiveIndex(null)
  }

  const nudge = (index: number, deltaDb: number): void => {
    const current = eq.bandGainsDb[index] ?? 0
    const next = Math.min(Math.max(current + deltaDb, BAND_GAIN_MIN_DB), BAND_GAIN_MAX_DB)
    onBandGain(index, Math.round(next * 2) / 2)
  }

  return (
    <div ref={wrapRef} className="eq-curve-wrap">
      <svg
        ref={svgRef}
        className="eq-curve"
        viewBox={`0 0 ${plotWidth} ${PLOT_HEIGHT}`}
        role="group"
        aria-label="Equalizer curve editor"
        onPointerMove={(event) => {
          if (dragIndex.current === null) return
          onBandGain(dragIndex.current, gainForClientY(event.clientY))
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        {[BAND_GAIN_MIN_DB, 0, BAND_GAIN_MAX_DB].map((gridDb) => (
          <g key={gridDb}>
            <line
              x1={CURVE_PAD_LEFT}
              x2={plotWidth - CURVE_PAD_RIGHT}
              y1={scale.yForDb(gridDb)}
              y2={scale.yForDb(gridDb)}
              className={gridDb === 0 ? 'eq-grid-zero' : 'eq-grid'}
            />
            <text x={CURVE_PAD_LEFT - 5} y={scale.yForDb(gridDb) + 4} textAnchor="end" className="eq-tick">
              {gridDb > 0 ? `+${gridDb}` : gridDb}
            </text>
          </g>
        ))}
        <path d={path} className="eq-curve-line" vectorEffect="non-scaling-stroke" />
        {BANDS.map((band) => {
          const gainDb = eq.bandGainsDb[band.index] ?? 0
          const cx = scale.xForHz(band.frequencyHz)
          // The node shows its band's own gain, so it only ever moves when
          // dragged and tracks the cursor exactly. The line is the combined
          // response underneath, which neighbors can pull off the node.
          const cy = scale.yForDb(gainDb)
          const active = activeIndex === band.index
          return (
            <g key={band.index}>
              <text x={cx} y={PLOT_HEIGHT - 5} textAnchor="middle" className="eq-tick">
                {band.label}
              </text>
              <g
                role="slider"
                tabIndex={0}
                aria-label={`${band.label} hertz band`}
                aria-valuemin={BAND_GAIN_MIN_DB}
                aria-valuemax={BAND_GAIN_MAX_DB}
                aria-valuenow={gainDb}
                aria-valuetext={formatDb(gainDb)}
                className={active ? 'eq-node active' : 'eq-node'}
                onPointerDown={(event) => {
                  dragIndex.current = band.index
                  setActiveIndex(band.index)
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
                onDoubleClick={() => onBandReset(band.index)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
                    event.preventDefault()
                    nudge(band.index, 0.5)
                  } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
                    event.preventDefault()
                    nudge(band.index, -0.5)
                  } else if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault()
                    onBandReset(band.index)
                  }
                }}
              >
                <circle cx={cx} cy={cy} r={14} className="eq-node-hit" />
                <circle cx={cx} cy={cy} r={6} className="eq-node-dot" />
              </g>
              {active && (
                <text x={cx} y={cy - 14} textAnchor="middle" className="eq-node-value">
                  {formatDb(gainDb)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
