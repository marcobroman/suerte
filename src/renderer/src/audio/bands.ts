export const ISO_BAND_FREQUENCIES: readonly number[] = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
]

/** Roughly one octave wide, the conventional graphic-EQ bandwidth. */
export const BAND_Q = 1.4
export const BASS_SHELF_HZ = 250
export const TREBLE_SHELF_HZ = 4000
export const SHELF_Q = Math.SQRT1_2

export interface Band {
  readonly index: number
  readonly frequencyHz: number
  readonly label: string
}

export function formatFrequency(hz: number): string {
  if (hz >= 1000) {
    const kilohertz = hz / 1000
    return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)}k`
  }
  return String(hz)
}

export function createBands(frequencies: readonly number[]): Band[] {
  return frequencies.map((frequencyHz, index) => ({
    index,
    frequencyHz,
    label: formatFrequency(frequencyHz)
  }))
}

export const BANDS: readonly Band[] = createBands(ISO_BAND_FREQUENCIES)
export const BAND_COUNT = BANDS.length

/**
 * BiquadFilterNode misbehaves at or above Nyquist, and some output devices report
 * rates low enough that the top ISO band would land there. Stay just under it.
 */
export function maxUsableFrequency(sampleRate: number): number {
  return (sampleRate / 2) * 0.99
}

export function isUsableFrequency(hz: number, sampleRate: number): boolean {
  return hz > 0 && hz < maxUsableFrequency(sampleRate)
}

/** Log-spaced grid, so the response curve reads evenly across the spectrum. */
export function logFrequencyGrid(fromHz: number, toHz: number, points: number): number[] {
  if (points < 2) return [fromHz]
  const ratio = toHz / fromHz
  const grid: number[] = []
  for (let i = 0; i < points; i++) {
    grid.push(fromHz * Math.pow(ratio, i / (points - 1)))
  }
  return grid
}
