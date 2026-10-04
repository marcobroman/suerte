import { describe, expect, it } from 'vitest'
import { BASS_SHELF_HZ, ISO_BAND_FREQUENCIES, TREBLE_SHELF_HZ } from '@/audio/bands'
import {
  clampMasterVolume,
  defaultEqSettings,
  normalizeEqSettings,
  resolveGraphSettings
} from '@/audio/settings'
import { dbToGain } from '@/audio/db'
import type { EqSettings } from '@shared/types'

const RATE = 48000

function withBands(gains: number[], extra: Partial<EqSettings> = {}): EqSettings {
  return { ...defaultEqSettings(), bandGainsDb: gains, ...extra }
}

describe('defaultEqSettings', () => {
  it('is flat with ten bands', () => {
    const settings = defaultEqSettings()
    expect(settings.bandGainsDb).toHaveLength(10)
    expect(settings.bandGainsDb.every((gain) => gain === 0)).toBe(true)
    expect(settings.autoPreamp).toBe(true)
  })

  it('returns a fresh object each call', () => {
    const first = defaultEqSettings()
    first.bandGainsDb[0] = 6
    expect(defaultEqSettings().bandGainsDb[0]).toBe(0)
  })
})

describe('clampMasterVolume', () => {
  it('clamps to the valid range', () => {
    expect(clampMasterVolume(-1)).toBe(0)
    expect(clampMasterVolume(0.5)).toBe(0.5)
    expect(clampMasterVolume(2)).toBe(1)
  })
})

describe('normalizeEqSettings', () => {
  it('fills in defaults for an empty input', () => {
    expect(normalizeEqSettings(null)).toEqual(defaultEqSettings())
    expect(normalizeEqSettings(undefined)).toEqual(defaultEqSettings())
    expect(normalizeEqSettings({})).toEqual(defaultEqSettings())
  })

  it('pads a short band array to ten', () => {
    const settings = normalizeEqSettings({ bandGainsDb: [3, -3] })
    expect(settings.bandGainsDb).toHaveLength(10)
    expect(settings.bandGainsDb.slice(0, 2)).toEqual([3, -3])
    expect(settings.bandGainsDb[2]).toBe(0)
  })

  it('truncates a long band array', () => {
    expect(normalizeEqSettings({ bandGainsDb: new Array(20).fill(1) }).bandGainsDb).toHaveLength(10)
  })

  it('clamps out-of-range values', () => {
    const settings = normalizeEqSettings({
      bandGainsDb: [99, -99],
      preampDb: 99,
      bassDb: -99,
      trebleDb: 99,
      masterVolume: 5
    })

    expect(settings.bandGainsDb[0]).toBe(12)
    expect(settings.bandGainsDb[1]).toBe(-12)
    expect(settings.preampDb).toBe(12)
    expect(settings.bassDb).toBe(-12)
    expect(settings.trebleDb).toBe(12)
    expect(settings.masterVolume).toBe(1)
  })

  it('replaces non-numeric junk with zero', () => {
    const settings = normalizeEqSettings({
      bandGainsDb: [Number.NaN, Number.POSITIVE_INFINITY, 'x' as unknown as number],
      preampDb: 'nope' as unknown as number
    })

    expect(settings.bandGainsDb.slice(0, 3)).toEqual([0, 0, 0])
    expect(settings.preampDb).toBe(0)
  })

  it('treats autoPreamp as true unless explicitly false', () => {
    expect(normalizeEqSettings({ autoPreamp: false }).autoPreamp).toBe(false)
    expect(normalizeEqSettings({ autoPreamp: true }).autoPreamp).toBe(true)
  })
})

describe('resolveGraphSettings', () => {
  it('passes band gains through unchanged when auto-preamp is off', () => {
    const resolved = resolveGraphSettings(
      withBands([6, 0, 0, 0, 0, 0, 0, 0, 0, 0], { autoPreamp: false }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.bands[0]?.gainDb).toBe(6)
    expect(resolved.preampGain).toBeCloseTo(1, 6)
  })

  it('attenuates by the largest boost when auto-preamp is on', () => {
    const resolved = resolveGraphSettings(
      withBands([6, 0, 0, 0, 0, 0, 0, 0, 0, 9], { autoPreamp: true }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.preampGain).toBeCloseTo(dbToGain(-9), 6)
  })

  it('counts shelf boosts toward auto-preamp', () => {
    const resolved = resolveGraphSettings(
      withBands([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { bassDb: 7, autoPreamp: true }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.preampGain).toBeCloseTo(dbToGain(-7), 6)
  })

  it('offsets the manual preamp by the auto-preamp amount', () => {
    const resolved = resolveGraphSettings(
      withBands([4, 0, 0, 0, 0, 0, 0, 0, 0, 0], { preampDb: -2, autoPreamp: true }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.preampGain).toBeCloseTo(dbToGain(-6), 6)
  })

  it('produces one filter per band', () => {
    const resolved = resolveGraphSettings(defaultEqSettings(), RATE, ISO_BAND_FREQUENCIES)
    expect(resolved.bands).toHaveLength(ISO_BAND_FREQUENCIES.length)
    expect(resolved.bands.map((band) => band.frequencyHz)).toEqual([...ISO_BAND_FREQUENCIES])
  })

  it('clamps band gains to the legal range', () => {
    const resolved = resolveGraphSettings(
      withBands([99, -99, 0, 0, 0, 0, 0, 0, 0, 0]),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.bands[0]?.gainDb).toBe(12)
    expect(resolved.bands[1]?.gainDb).toBe(-12)
  })

  it('relocates bands above the usable range to the highest usable centre', () => {
    // At an 8 kHz context rate everything from 4 kHz up is past the usable limit.
    const resolved = resolveGraphSettings(defaultEqSettings(), 8000, ISO_BAND_FREQUENCIES)

    expect(resolved.bands[0]?.frequencyHz).toBe(31)
    expect(resolved.bands[6]?.frequencyHz).toBe(2000)
    expect(resolved.bands.at(-1)?.frequencyHz).toBe(2000)
    for (const band of resolved.bands) {
      expect(band.frequencyHz).toBeLessThan(8000 / 2)
    }
  })

  it('keeps every band unchanged at a normal rate', () => {
    const resolved = resolveGraphSettings(defaultEqSettings(), 48000, ISO_BAND_FREQUENCIES)
    expect(resolved.bands.map((band) => band.frequencyHz)).toEqual([...ISO_BAND_FREQUENCIES])
  })

  it('reports the shelf frequencies', () => {
    const resolved = resolveGraphSettings(
      withBands([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { bassDb: 3, trebleDb: -2 }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.bass.frequencyHz).toBe(BASS_SHELF_HZ)
    expect(resolved.bass.gainDb).toBe(3)
    expect(resolved.treble.frequencyHz).toBe(TREBLE_SHELF_HZ)
    expect(resolved.treble.gainDb).toBe(-2)
  })

  it('passes master volume through', () => {
    const resolved = resolveGraphSettings(
      withBands([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], { masterVolume: 0.4 }),
      RATE,
      ISO_BAND_FREQUENCIES
    )

    expect(resolved.masterGain).toBe(0.4)
  })

  it('handles a band list shorter than the settings array', () => {
    const resolved = resolveGraphSettings(withBands([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), RATE, [100, 200])
    expect(resolved.bands).toHaveLength(2)
    expect(resolved.bands[0]?.gainDb).toBe(3)
  })
})
