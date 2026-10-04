import { describe, expect, it } from 'vitest'
import {
  BAND_COUNT,
  BANDS,
  createBands,
  formatFrequency,
  isUsableFrequency,
  ISO_BAND_FREQUENCIES,
  logFrequencyGrid,
  maxUsableFrequency
} from '@/audio/bands'
import { at } from '../helpers'

describe('ISO_BAND_FREQUENCIES', () => {
  it('is the classic ten octave-spaced bands', () => {
    expect(ISO_BAND_FREQUENCIES).toEqual([31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])
    expect(BAND_COUNT).toBe(10)
  })

  it('is strictly increasing', () => {
    for (let i = 1; i < ISO_BAND_FREQUENCIES.length; i++) {
      expect(at(ISO_BAND_FREQUENCIES, i)).toBeGreaterThan(at(ISO_BAND_FREQUENCIES, i - 1))
    }
  })

  it('is approximately octave-spaced', () => {
    // Nominal ISO centres are rounded to integers, so 125/62 is 2.016 rather than 2.
    for (let i = 1; i < ISO_BAND_FREQUENCIES.length; i++) {
      const ratio = at(ISO_BAND_FREQUENCIES, i) / at(ISO_BAND_FREQUENCIES, i - 1)
      expect(ratio).toBeCloseTo(2, 1)
    }
  })
})

describe('createBands', () => {
  it('labels each band and keeps input order', () => {
    const bands = createBands([31, 1000, 16000])
    expect(bands).toEqual([
      { index: 0, frequencyHz: 31, label: '31' },
      { index: 1, frequencyHz: 1000, label: '1k' },
      { index: 2, frequencyHz: 16000, label: '16k' }
    ])
  })

  it('drives the exported band table', () => {
    expect(BANDS).toHaveLength(BAND_COUNT)
    expect(at(BANDS, 0).frequencyHz).toBe(31)
  })
})

describe('formatFrequency', () => {
  it('leaves hertz alone and abbreviates kilohertz', () => {
    expect(formatFrequency(31)).toBe('31')
    expect(formatFrequency(125)).toBe('125')
    expect(formatFrequency(1000)).toBe('1k')
    expect(formatFrequency(16000)).toBe('16k')
  })

  it('keeps one decimal for fractional kilohertz', () => {
    expect(formatFrequency(1500)).toBe('1.5k')
  })
})

describe('nyquist guards', () => {
  it('keeps usable frequencies below nyquist', () => {
    expect(isUsableFrequency(16000, 44100)).toBe(true)
    expect(isUsableFrequency(0, 44100)).toBe(false)
    expect(isUsableFrequency(-100, 44100)).toBe(false)
    expect(isUsableFrequency(23000, 44100)).toBe(false)
  })

  it('rejects the top band on a low-rate device', () => {
    // 32 kHz output puts 16 kHz at nyquist, where biquads go unstable.
    expect(isUsableFrequency(16000, 32000)).toBe(false)
    expect(maxUsableFrequency(32000)).toBeLessThan(16000)
  })
})

describe('logFrequencyGrid', () => {
  it('spans the requested range', () => {
    const grid = logFrequencyGrid(20, 20000, 5)
    expect(grid).toHaveLength(5)
    expect(at(grid, 0)).toBeCloseTo(20, 6)
    expect(at(grid, 4)).toBeCloseTo(20000, 6)
  })

  it('is monotonically increasing and evenly spaced in log space', () => {
    const grid = logFrequencyGrid(20, 20000, 64)
    for (let i = 1; i < grid.length; i++) {
      expect(at(grid, i)).toBeGreaterThan(at(grid, i - 1))
    }
    const ratio = at(grid, 1) / at(grid, 0)
    for (let i = 1; i < grid.length; i++) {
      expect(at(grid, i) / at(grid, i - 1)).toBeCloseTo(ratio, 6)
    }
  })

  it('degrades to a single point', () => {
    expect(logFrequencyGrid(20, 20000, 1)).toEqual([20])
  })
})
