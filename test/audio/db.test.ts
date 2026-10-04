import { describe, expect, it } from 'vitest'
import {
  autoPreampDb,
  BAND_GAIN_MAX_DB,
  BAND_GAIN_MIN_DB,
  clamp,
  clampBandGain,
  clampPreamp,
  dbToGain,
  formatDb,
  gainToDb,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB
} from '@/audio/db'

describe('clamp', () => {
  it('bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })

  it('handles an inverted range without throwing', () => {
    expect(clamp(5, 10, 0)).toBe(10)
  })
})

describe('dbToGain / gainToDb', () => {
  it('round-trips', () => {
    for (const db of [-24, -12, -6, 0, 3, 6, 12]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 10)
    }
  })

  it('maps unity to unity', () => {
    expect(dbToGain(0)).toBe(1)
  })

  it('treats +6 dB as roughly a doubling in amplitude', () => {
    // Exactly 2x is 20*log10(2) = 6.0206 dB; 6.0 lands a hair under.
    expect(dbToGain(6)).toBeCloseTo(2, 1)
    expect(gainToDb(2)).toBeCloseTo(6.0206, 3)
    expect(dbToGain(gainToDb(2))).toBeCloseTo(2, 6)
  })

  it('treats -6 dB as roughly a halving in amplitude', () => {
    expect(dbToGain(-6)).toBeCloseTo(0.5, 2)
    expect(dbToGain(gainToDb(0.5))).toBeCloseTo(0.5, 6)
  })

  it('reports non-positive gains as -Infinity', () => {
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY)
    expect(gainToDb(-1)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('clampBandGain', () => {
  it('applies the band limits', () => {
    expect(clampBandGain(40)).toBe(BAND_GAIN_MAX_DB)
    expect(clampBandGain(-40)).toBe(BAND_GAIN_MIN_DB)
    expect(clampBandGain(4.5)).toBe(4.5)
  })
})

describe('clampPreamp', () => {
  it('applies the preamp limits', () => {
    expect(clampPreamp(40)).toBe(PREAMP_MAX_DB)
    expect(clampPreamp(-80)).toBe(PREAMP_MIN_DB)
  })
})

describe('autoPreampDb', () => {
  it('is silent headroom when nothing is boosted', () => {
    expect(autoPreampDb([0, 0, 0])).toBe(0)
  })

  it('does not attenuate for cuts', () => {
    expect(autoPreampDb([-12, -6, 0])).toBe(0)
  })

  it('cancels the largest single boost', () => {
    expect(autoPreampDb([3, 9, -4])).toBe(-9)
  })

  it('reserves headroom across bands and shelves together', () => {
    expect(autoPreampDb([6, -6, 0, 6, 0, 0, 0, 0, 4, 0, 7, 3])).toBe(-7)
  })

  it('never goes below the preamp floor', () => {
    expect(autoPreampDb([120])).toBe(PREAMP_MIN_DB)
  })
})

describe('formatDb', () => {
  it('signs positive values', () => {
    expect(formatDb(3)).toBe('+3.0')
    expect(formatDb(-3)).toBe('-3.0')
    expect(formatDb(0)).toBe('0.0')
  })

  it('renders non-finite values', () => {
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe('-inf')
  })
})
