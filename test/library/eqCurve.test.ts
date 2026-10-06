import { describe, expect, it } from 'vitest'
import { ISO_BAND_FREQUENCIES } from '@/audio/bands'
import { BAND_GAIN_MAX_DB, BAND_GAIN_MIN_DB } from '@/audio/db'
import {
  EQ_CURVE_MAX_HZ,
  EQ_CURVE_MIN_HZ,
  bandShapeNodes,
  createCurveScale,
  smoothPath
} from '@/library/eqCurve'

describe('bandShapeNodes', () => {
  it('pins every band gain at its centre', () => {
    const gains = [6, 0, 0, 0, 0, 0, 0, 0, 0, -6]
    const nodes = bandShapeNodes(gains)

    expect(nodes).toHaveLength(ISO_BAND_FREQUENCIES.length + 2)
    for (let index = 0; index < ISO_BAND_FREQUENCIES.length; index++) {
      expect(nodes[index + 1]?.frequencyHz).toBe(ISO_BAND_FREQUENCIES[index])
      expect(nodes[index + 1]?.gainDb).toBe(gains[index])
    }
  })

  it('extends flat to the plot edges', () => {
    const nodes = bandShapeNodes([6, 0, 0, 0, 0, 0, 0, 0, 0, -6])

    expect(nodes[0]).toEqual({ frequencyHz: EQ_CURVE_MIN_HZ, gainDb: 6 })
    expect(nodes[nodes.length - 1]).toEqual({ frequencyHz: EQ_CURVE_MAX_HZ, gainDb: -6 })
  })

  it('defaults missing gains to flat', () => {
    const nodes = bandShapeNodes([])

    expect(nodes).toHaveLength(ISO_BAND_FREQUENCIES.length + 2)
    for (const node of nodes) expect(node.gainDb).toBe(0)
  })
})

describe('smoothPath', () => {
  it('is empty without points and flat for a single point', () => {
    expect(smoothPath([])).toBe('')
    expect(smoothPath([{ x: 1, y: 2 }])).toBe('M1.0,2.0')
  })

  it('joins two points with a straight segment', () => {
    expect(
      smoothPath([
        { x: 0, y: 0 },
        { x: 10, y: 10 }
      ])
    ).toBe('M0.0,0.0 L10.0,10.0')
  })

  it('starts and ends exactly on the first and last points', () => {
    const path = smoothPath([
      { x: 0, y: 5 },
      { x: 10, y: 0 },
      { x: 20, y: 5 },
      { x: 30, y: 5 }
    ])

    expect(path.startsWith('M0.0,5.0')).toBe(true)
    expect(path.endsWith('30.0,5.0')).toBe(true)
    expect(path).toContain('C')
  })

  it('renders a straight line for collinear points', () => {
    const path = smoothPath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 20 }
    ])
    const numbers = path.match(/-?\d+\.\d+/g)?.map(Number) ?? []

    // On a perfect diagonal every control point sits on y = x.
    for (let index = 0; index < numbers.length; index += 2) {
      expect(Math.abs((numbers[index] ?? 0) - (numbers[index + 1] ?? 0))).toBeLessThan(0.06)
    }
  })
})

describe('createCurveScale', () => {
  const scale = createCurveScale(600, 170)

  it('pins the frequency edges to the plot padding', () => {
    expect(scale.xForHz(EQ_CURVE_MIN_HZ)).toBeCloseTo(34, 5)
    expect(scale.xForHz(EQ_CURVE_MAX_HZ)).toBeCloseTo(592, 5)
    expect(scale.xForHz(1000)).toBeGreaterThan(scale.xForHz(100))
    expect(scale.xForHz(10000)).toBeGreaterThan(scale.xForHz(1000))
  })

  it('round-trips gains through pixels', () => {
    for (const gainDb of [-12, -3.5, 0, 4, 12]) {
      expect(scale.dbForY(scale.yForDb(gainDb))).toBeCloseTo(gainDb, 5)
    }
  })

  it('clamps drags to the fader range, not the display margin', () => {
    expect(scale.dbForY(-1000)).toBe(BAND_GAIN_MAX_DB)
    expect(scale.dbForY(1000)).toBe(BAND_GAIN_MIN_DB)
  })
})
