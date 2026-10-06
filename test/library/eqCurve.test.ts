import { describe, expect, it } from 'vitest'
import { defaultEqSettings } from '@/audio/settings'
import { BAND_GAIN_MAX_DB, BAND_GAIN_MIN_DB } from '@/audio/db'
import {
  EQ_CURVE_MAX_HZ,
  EQ_CURVE_MIN_HZ,
  EQ_CURVE_POINTS,
  createCurveScale,
  eqCurveDb,
  smoothPath
} from '@/library/eqCurve'

describe('eqCurveDb', () => {
  it('samples the full audio band on a log grid', () => {
    const curve = eqCurveDb(defaultEqSettings())

    expect(curve.frequenciesHz).toHaveLength(EQ_CURVE_POINTS)
    expect(curve.magnitudesDb).toHaveLength(EQ_CURVE_POINTS)
    expect(curve.frequenciesHz[0]).toBe(EQ_CURVE_MIN_HZ)
    expect(curve.frequenciesHz[curve.frequenciesHz.length - 1]).toBe(EQ_CURVE_MAX_HZ)
  })

  it('renders a flat curve for flat settings', () => {
    const { magnitudesDb } = eqCurveDb(defaultEqSettings())

    for (const gainDb of magnitudesDb) expect(gainDb).toBeCloseTo(0, 5)
  })

  it('peaks near the boosted band centre', () => {
    // Auto preamp off here, so the boost is visible uncompensated.
    const boosted = {
      ...defaultEqSettings(),
      autoPreamp: false,
      bandGainsDb: [0, 0, 0, 0, 0, 6, 0, 0, 0, 0]
    }
    const { frequenciesHz, magnitudesDb } = eqCurveDb(boosted)

    let peak = Number.NEGATIVE_INFINITY
    let peakHz = 0
    for (let index = 0; index < frequenciesHz.length; index++) {
      const gain = magnitudesDb[index] ?? Number.NEGATIVE_INFINITY
      if (gain > peak) {
        peak = gain
        peakHz = frequenciesHz[index] ?? 0
      }
    }
    // 1 kHz band with Q 1.4: the peak sits close to, not exactly on, centre.
    expect(peakHz).toBeGreaterThan(700)
    expect(peakHz).toBeLessThan(1400)
    expect(peak).toBeGreaterThan(4)
  })

  it('ignores preamp in the display curve', () => {
    const flat = eqCurveDb(defaultEqSettings()).magnitudesDb
    const hot = eqCurveDb({ ...defaultEqSettings(), preampDb: 6, autoPreamp: false }).magnitudesDb

    expect(hot).toHaveLength(flat.length)
    for (let index = 0; index < flat.length; index++) {
      expect(hot[index] ?? 0).toBeCloseTo(flat[index] ?? 0, 5)
    }
  })

  it('renders boosts undiminished despite auto preamp', () => {
    const boosted = { ...defaultEqSettings(), bandGainsDb: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0] }
    const { magnitudesDb } = eqCurveDb(boosted)

    // Headroom compensation stays in the audio chain, not the picture.
    expect(Math.max(...magnitudesDb)).toBeGreaterThan(4)
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
