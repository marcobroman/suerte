import type { EqSettings } from '@shared/types'
import { BAND_GAIN_MAX_DB, BAND_GAIN_MIN_DB } from '../audio/db'
import { BAND_Q, ISO_BAND_FREQUENCIES, SHELF_Q, logFrequencyGrid } from '../audio/bands'
import { responseCurveDb, type FilterSpec } from '../audio/response'
import { resolveGraphSettings, type ResolvedGraphSettings } from '../audio/settings'

export const EQ_CURVE_MIN_HZ = 20
export const EQ_CURVE_MAX_HZ = 20000
export const EQ_CURVE_POINTS = 128
/** Display-only rate; the top band only relocates on ≤32 kHz devices. */
export const EQ_CURVE_SAMPLE_RATE = 48000

export interface EqCurveData {
  readonly frequenciesHz: readonly number[]
  readonly magnitudesDb: readonly number[]
}

/**
 * Display curve for the panel: the filter cascade only, pivoting around 0 dB.
 * Preamp and auto-preamp headroom are deliberately excluded — they shift overall
 * loudness, not tone, and including them makes a boost look like it pushes
 * everything else down. The live chain is untouched and still compensates.
 * Pure, so the panel renders it with no audio objects involved.
 */
export function eqCurveDb(eq: EqSettings, sampleRate: number = EQ_CURVE_SAMPLE_RATE): EqCurveData {
  const resolved = resolveGraphSettings(eq, sampleRate, ISO_BAND_FREQUENCIES)
  const frequenciesHz = logFrequencyGrid(EQ_CURVE_MIN_HZ, EQ_CURVE_MAX_HZ, EQ_CURVE_POINTS)
  const cascadeDb = responseCurveDb(
    { sampleRate, filters: cascadeFilters(resolved) },
    frequenciesHz
  )
  return { frequenciesHz, magnitudesDb: cascadeDb }
}

function cascadeFilters(resolved: ResolvedGraphSettings): FilterSpec[] {
  return [
    ...resolved.bands.map((band) => ({
      kind: 'peaking' as const,
      frequencyHz: band.frequencyHz,
      gainDb: band.gainDb,
      q: BAND_Q
    })),
    { kind: 'lowshelf' as const, frequencyHz: resolved.bass.frequencyHz, gainDb: resolved.bass.gainDb, q: SHELF_Q },
    { kind: 'highshelf' as const, frequencyHz: resolved.treble.frequencyHz, gainDb: resolved.treble.gainDb, q: SHELF_Q }
  ]
}

export interface CurvePoint {
  readonly x: number
  readonly y: number
}

/** Plot padding in pixels; the scale and the SVG share these. */
export const CURVE_PAD_LEFT = 34
export const CURVE_PAD_RIGHT = 8
export const CURVE_PAD_TOP = 8
export const CURVE_PAD_BOTTOM = 18

/** Display headroom past the ±12 dB fader range so peaks never clip the frame. */
export const CURVE_DB_MARGIN = 3

export interface CurveScale {
  readonly width: number
  readonly height: number
  xForHz(hz: number): number
  yForDb(gainDb: number): number
  /** Inverse mapping for dragging, clamped to the fader range. */
  dbForY(y: number): number
}

/** Pixel mapping for a measured plot box. Pure, so drag math is unit-testable. */
export function createCurveScale(width: number, height: number): CurveScale {
  const innerWidth = Math.max(1, width - CURVE_PAD_LEFT - CURVE_PAD_RIGHT)
  const innerHeight = Math.max(1, height - CURVE_PAD_TOP - CURVE_PAD_BOTTOM)
  const logSpan = Math.log10(EQ_CURVE_MAX_HZ / EQ_CURVE_MIN_HZ)
  const topDb = BAND_GAIN_MAX_DB + CURVE_DB_MARGIN
  const bottomDb = BAND_GAIN_MIN_DB - CURVE_DB_MARGIN

  const clampDb = (gainDb: number): number =>
    Math.min(Math.max(gainDb, BAND_GAIN_MIN_DB), BAND_GAIN_MAX_DB)

  return {
    width,
    height,
    xForHz(hz: number): number {
      const clampedHz = Math.min(Math.max(hz, EQ_CURVE_MIN_HZ), EQ_CURVE_MAX_HZ)
      return CURVE_PAD_LEFT + (Math.log10(clampedHz / EQ_CURVE_MIN_HZ) / logSpan) * innerWidth
    },
    yForDb(gainDb: number): number {
      const clamped = Math.min(Math.max(gainDb, bottomDb), topDb)
      return CURVE_PAD_TOP + ((topDb - clamped) / (topDb - bottomDb)) * innerHeight
    },
    dbForY(y: number): number {
      const clampedY = Math.min(Math.max(y, CURVE_PAD_TOP), height - CURVE_PAD_BOTTOM)
      const ratio = (clampedY - CURVE_PAD_TOP) / innerHeight
      return clampDb(topDb - ratio * (topDb - bottomDb))
    }
  }
}

/**
 * Catmull-Rom spline through the points, emitted as cubic Béziers, so the
 * rendered curve reads as one smooth stroke instead of rigid segments.
 * Endpoints are duplicated (not reflected), so the path starts and ends
 * exactly on the first and last points with no overshoot past the range.
 */
export function smoothPath(points: readonly CurvePoint[]): string {
  const first = points[0]
  if (!first) return ''
  let path = `M${first.x.toFixed(1)},${first.y.toFixed(1)}`
  if (points.length < 3) {
    for (const point of points.slice(1)) {
      path += ` L${point.x.toFixed(1)},${point.y.toFixed(1)}`
    }
    return path
  }
  for (let index = 0; index < points.length - 1; index++) {
    const current = points[index]
    const next = points[index + 1]
    if (!current || !next) continue
    const previous = points[index - 1] ?? current
    const after = points[index + 2] ?? next
    const control1X = current.x + (next.x - previous.x) / 6
    const control1Y = current.y + (next.y - previous.y) / 6
    const control2X = next.x - (after.x - current.x) / 6
    const control2Y = next.y - (after.y - current.y) / 6
    path +=
      ` C${control1X.toFixed(1)},${control1Y.toFixed(1)}` +
      ` ${control2X.toFixed(1)},${control2Y.toFixed(1)}` +
      ` ${next.x.toFixed(1)},${next.y.toFixed(1)}`
  }
  return path
}
