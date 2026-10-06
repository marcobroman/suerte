import { describe, expect, it } from 'vitest'
import { EQ_BAND_COUNT } from '@shared/types'
import { ISO_BAND_FREQUENCIES } from '@/audio/bands'
import { BAND_GAIN_MAX_DB, BAND_GAIN_MIN_DB } from '@/audio/db'
import { EQ_PRESETS, eqPresetById } from '@/library/eqPresets'

describe('EQ_PRESETS', () => {
  it('covers every ISO band the DSP renders', () => {
    expect(ISO_BAND_FREQUENCIES).toHaveLength(EQ_BAND_COUNT)
    for (const preset of EQ_PRESETS) {
      expect(preset.bandGainsDb).toHaveLength(ISO_BAND_FREQUENCIES.length)
    }
  })

  it('has unique ids and labels', () => {
    const ids = EQ_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const preset of EQ_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })

  it('keeps every gain inside the hardware range', () => {
    for (const preset of EQ_PRESETS) {
      for (const gain of preset.bandGainsDb) {
        expect(gain).toBeGreaterThanOrEqual(BAND_GAIN_MIN_DB)
        expect(gain).toBeLessThanOrEqual(BAND_GAIN_MAX_DB)
      }
    }
  })

  it('ships a flat preset that changes nothing', () => {
    const flat = eqPresetById('flat')
    expect(flat?.bandGainsDb.every((gain) => gain === 0)).toBe(true)
    expect(flat).toMatchObject({ bassDb: 0, trebleDb: 0 })
  })

  it('looks presets up by id', () => {
    expect(eqPresetById('rock')?.label).toBe('Rock')
    expect(eqPresetById('nope')).toBeUndefined()
  })
})
