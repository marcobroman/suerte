export const BAND_GAIN_MIN_DB = -12
export const BAND_GAIN_MAX_DB = 12
export const SHELF_GAIN_MIN_DB = -12
export const SHELF_GAIN_MAX_DB = 12
export const PREAMP_MIN_DB = -24
export const PREAMP_MAX_DB = 12

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(gain)
}

export function clampBandGain(db: number): number {
  return clamp(db, BAND_GAIN_MIN_DB, BAND_GAIN_MAX_DB)
}

export function clampShelfGain(db: number): number {
  return clamp(db, SHELF_GAIN_MIN_DB, SHELF_GAIN_MAX_DB)
}

export function clampPreamp(db: number): number {
  return clamp(db, PREAMP_MIN_DB, PREAMP_MAX_DB)
}

/**
 * Headroom offset that cancels the largest boost in the chain. Cascading filters
 * can exceed 0 dB and clip the output; attenuating by the worst-case single boost
 * is the conventional guarantee. Summing every positive gain would be tighter but
 * over-attenuates, since bands are rarely all in phase at the same frequency.
 */
export function autoPreampDb(gainsDb: readonly number[]): number {
  let peak = 0
  for (const gain of gainsDb) {
    if (gain > peak) peak = gain
  }
  // Negating zero would yield -0, which formats as "-0.0".
  if (peak === 0) return 0
  return clamp(-peak, PREAMP_MIN_DB, PREAMP_MAX_DB)
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db)) return '-inf'
  const sign = db > 0 ? '+' : ''
  return `${sign}${db.toFixed(1)}`
}
