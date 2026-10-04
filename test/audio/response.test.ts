import { describe, expect, it } from 'vitest'
import { BAND_Q, BANDS, SHELF_Q } from '@/audio/bands'
import {
  defaultEqParams,
  designBiquad,
  designEq,
  magnitudeDbAt,
  responseCurveDb,
  type EqCurveParams
} from '@/audio/response'
import { at } from '../helpers'

const FS = 48000

describe('designBiquad peaking', () => {
  it('reaches exactly the requested gain at its centre frequency', () => {
    for (const gainDb of [-12, -6, 3, 6, 12]) {
      const c = designBiquad('peaking', FS, 1000, BAND_Q, gainDb)
      expect(magnitudeDbAt(c, FS, 1000)).toBeCloseTo(gainDb, 6)
    }
  })

  it('is unity at dc for a peaking filter', () => {
    const c = designBiquad('peaking', FS, 1000, BAND_Q, 9)
    expect(magnitudeDbAt(c, FS, 0)).toBeCloseTo(0, 6)
  })

  it('returns to unity far from the centre', () => {
    const c = designBiquad('peaking', FS, 1000, BAND_Q, 9)
    expect(magnitudeDbAt(c, FS, 20)).toBeCloseTo(0, 1)
    expect(magnitudeDbAt(c, FS, 18000)).toBeCloseTo(0, 1)
  })

  it('cuts when the gain is negative', () => {
    const c = designBiquad('peaking', FS, 1000, BAND_Q, -9)
    expect(magnitudeDbAt(c, FS, 1000)).toBeCloseTo(-9, 6)
  })

  it('is unity everywhere when the gain is zero', () => {
    const c = designBiquad('peaking', FS, 1000, BAND_Q, 0)
    for (const hz of [20, 100, 1000, 10000, 20000]) {
      expect(magnitudeDbAt(c, FS, hz)).toBeCloseTo(0, 9)
    }
  })

  it('is symmetric in gain', () => {
    const up = designBiquad('peaking', FS, 1000, BAND_Q, 8)
    const down = designBiquad('peaking', FS, 1000, BAND_Q, -8)
    for (const hz of [100, 700, 1400, 8000]) {
      expect(magnitudeDbAt(up, FS, hz)).toBeCloseTo(-magnitudeDbAt(down, FS, hz), 6)
    }
  })

  it('stays stable when asked for a frequency at or above nyquist', () => {
    for (const hz of [24000, 30000]) {
      const c = designBiquad('peaking', FS, hz, BAND_Q, 6)
      expect(Number.isFinite(magnitudeDbAt(c, FS, 1000))).toBe(true)
    }
  })
})

describe('designBiquad lowshelf', () => {
  it('applies the full gain at dc and rolls off above the corner', () => {
    const c = designBiquad('lowshelf', FS, 250, SHELF_Q, 9)
    expect(magnitudeDbAt(c, FS, 0)).toBeCloseTo(9, 6)
    // 20 kHz is asymptotic, not exactly at nyquist, so a little ripple remains.
    expect(magnitudeDbAt(c, FS, 20000)).toBeCloseTo(0, 3)
  })

  it('cuts at dc for a negative gain', () => {
    const c = designBiquad('lowshelf', FS, 250, SHELF_Q, -9)
    expect(magnitudeDbAt(c, FS, 0)).toBeCloseTo(-9, 6)
    expect(magnitudeDbAt(c, FS, 20000)).toBeCloseTo(0, 3)
  })

  it('is flat for zero gain', () => {
    const c = designBiquad('lowshelf', FS, 250, SHELF_Q, 0)
    for (const hz of [0, 100, 1000, 20000]) {
      expect(magnitudeDbAt(c, FS, hz)).toBeCloseTo(0, 6)
    }
  })
})

describe('designBiquad highshelf', () => {
  it('applies the full gain near nyquist and is flat at dc', () => {
    const c = designBiquad('highshelf', FS, 4000, SHELF_Q, 9)
    expect(magnitudeDbAt(c, FS, 24000)).toBeCloseTo(9, 6)
    expect(magnitudeDbAt(c, FS, 0)).toBeCloseTo(0, 6)
  })

  it('cuts near nyquist for a negative gain', () => {
    const c = designBiquad('highshelf', FS, 4000, SHELF_Q, -9)
    expect(magnitudeDbAt(c, FS, 24000)).toBeCloseTo(-9, 6)
  })
})

describe('designEq', () => {
  it('omits zero-gain filters', () => {
    const params: EqCurveParams = {
      sampleRate: FS,
      filters: [
        { kind: 'peaking', frequencyHz: 1000, gainDb: 0, q: BAND_Q },
        { kind: 'peaking', frequencyHz: 2000, gainDb: 6, q: BAND_Q }
      ]
    }
    expect(designEq(params)).toHaveLength(1)
  })

  it('designs nothing for a flat eq', () => {
    expect(
      designEq({ sampleRate: FS, filters: [{ kind: 'peaking', frequencyHz: 1000, gainDb: 0, q: 1 }] })
    ).toHaveLength(0)
  })
})

describe('responseCurveDb', () => {
  it('is exactly flat when every gain is zero', () => {
    const curve = responseCurveDb(defaultEqParams(FS, new Array(10).fill(0), 0, 0), [20, 1000, 20000])
    for (const value of curve) expect(value).toBe(0)
  })

  it('adds band gains in dB across a serial chain', () => {
    // Two adjacent bands both boosted 6 dB: at 1 kHz the 1 kHz band contributes its
    // full 6 dB and the 2 kHz band contributes a little, so the sum exceeds either alone.
    const gains = new Array(10).fill(0)
    gains[5] = 6
    gains[6] = 6
    const curve = responseCurveDb(defaultEqParams(FS, gains, 0, 0), [1000, 2000])
    expect(at(curve, 0)).toBeGreaterThan(6)
    expect(at(curve, 1)).toBeGreaterThan(6)
  })

  it('tracks a single band at its own centre', () => {
    const gains = new Array(10).fill(0)
    gains[3] = 7.5
    const curve = responseCurveDb(defaultEqParams(FS, gains, 0, 0), [250])
    expect(at(curve, 0)).toBeCloseTo(7.5, 6)
  })

  it('combines shelves and bands', () => {
    const gains = new Array(10).fill(0)
    gains[0] = 6
    const curve = responseCurveDb(defaultEqParams(FS, gains, 6, 0), [20, 20000])
    // Bass shelf and 31 Hz band overlap at the bottom, treble shelf untouched up top.
    expect(at(curve, 0)).toBeGreaterThan(6)
    expect(at(curve, 1)).toBeCloseTo(0, 1)
  })

  it('produces one value per requested frequency', () => {
    const frequencies = [20, 100, 1000, 10000]
    expect(responseCurveDb(defaultEqParams(FS, new Array(10).fill(0), 0, 0), frequencies)).toHaveLength(
      4
    )
  })

  it('pushes every band centre in its own direction despite neighbour bleed', () => {
    // Cascaded peaking filters overlap: a band never reaches its full nominal gain
    // once neighbours contribute. This is the interaction a real graphic EQ has,
    // so assert direction and rough magnitude rather than exact values.
    const gains = BANDS.map((_, index) => (index % 2 === 0 ? 6 : -6))
    const params = defaultEqParams(FS, gains, 0, 0)

    for (const band of BANDS) {
      const value = at(responseCurveDb(params, [band.frequencyHz]), 0)
      if (band.index % 2 === 0) {
        expect(value).toBeGreaterThan(1)
        expect(value).toBeLessThan(6)
      } else {
        expect(value).toBeLessThan(-1)
        expect(value).toBeGreaterThan(-6)
      }
    }
  })
})
