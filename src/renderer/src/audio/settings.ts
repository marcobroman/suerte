import type { EqSettings } from '@shared/types'
import {
  autoPreampDb,
  clamp,
  clampBandGain,
  clampPreamp,
  clampShelfGain,
  dbToGain
} from './db'
import {
  BAND_Q,
  BASS_SHELF_HZ,
  SHELF_Q,
  TREBLE_SHELF_HZ,
  isUsableFrequency
} from './bands'

export const MASTER_VOLUME_MIN = 0
export const MASTER_VOLUME_MAX = 1

export function defaultEqSettings(): EqSettings {
  return {
    bandGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    preampDb: 0,
    autoPreamp: true,
    bassDb: 0,
    trebleDb: 0,
    masterVolume: 0.85
  }
}

export function clampMasterVolume(volume: number): number {
  return clamp(volume, MASTER_VOLUME_MIN, MASTER_VOLUME_MAX)
}

/** Coerces anything loaded from disk into a usable, in-range settings object. */
export function normalizeEqSettings(input: Partial<EqSettings> | null | undefined): EqSettings {
  const source = input ?? {}
  const bands = Array.isArray(source.bandGainsDb) ? source.bandGainsDb : []
  const bandGainsDb = Array.from({ length: 10 }, (_, index) => {
    const value = bands[index]
    return typeof value === 'number' && Number.isFinite(value) ? clampBandGain(value) : 0
  })

  const finite = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return {
    bandGainsDb,
    preampDb: clampPreamp(finite(source.preampDb, 0)),
    autoPreamp: source.autoPreamp !== false,
    bassDb: clampShelfGain(finite(source.bassDb, 0)),
    trebleDb: clampShelfGain(finite(source.trebleDb, 0)),
    masterVolume: clampMasterVolume(finite(source.masterVolume, 0.85))
  }
}

export interface FilterSettings {
  readonly frequencyHz: number
  readonly gainDb: number
  readonly q: number
}

export interface ResolvedGraphSettings {
  readonly preampGain: number
  readonly bands: readonly FilterSettings[]
  readonly bass: FilterSettings
  readonly treble: FilterSettings
  readonly masterGain: number
}

/**
 * Turns user settings into the concrete values pushed onto live Web Audio nodes.
 * Frequencies above the context's usable range are pulled down to the top band's
 * centre, which keeps every band audible instead of silently flattening the top of
 * the spectrum on low-rate output devices.
 */
export function resolveGraphSettings(
  settings: EqSettings,
  sampleRate: number,
  bandFrequenciesHz: readonly number[]
): ResolvedGraphSettings {
  // Highest band centre the context can actually render; anything above it is
  // relocated here rather than left inaudible.
  let fallbackHz = bandFrequenciesHz[0] ?? 1000
  for (const frequencyHz of bandFrequenciesHz) {
    if (isUsableFrequency(frequencyHz, sampleRate)) fallbackHz = frequencyHz
  }

  const bands: FilterSettings[] = []
  for (const [index, frequencyHz] of bandFrequenciesHz.entries()) {
    const gainDb = settings.bandGainsDb[index] ?? 0
    bands.push({
      frequencyHz: isUsableFrequency(frequencyHz, sampleRate) ? frequencyHz : fallbackHz,
      gainDb: clampBandGain(gainDb),
      q: BAND_Q
    })
  }

  const peak = autoPreampDb([
    ...settings.bandGainsDb,
    settings.bassDb,
    settings.trebleDb
  ])
  const preampDb = clampPreamp(
    settings.autoPreamp ? clampPreamp(settings.preampDb) + peak : clampPreamp(settings.preampDb)
  )

  return {
    preampGain: dbToGain(preampDb),
    bands,
    bass: { frequencyHz: BASS_SHELF_HZ, gainDb: clampShelfGain(settings.bassDb), q: SHELF_Q },
    treble: {
      frequencyHz: TREBLE_SHELF_HZ,
      gainDb: clampShelfGain(settings.trebleDb),
      q: SHELF_Q
    },
    masterGain: clampMasterVolume(settings.masterVolume)
  }
}
