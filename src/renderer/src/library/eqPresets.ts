export interface EqPreset {
  readonly id: string
  readonly label: string
  /** One gain per ISO band, 31 Hz through 16 kHz. */
  readonly bandGainsDb: readonly number[]
  readonly bassDb: number
  readonly trebleDb: number
}

/** Classic graphic-EQ curves. Gains stay inside the ±12 dB band range. */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', label: 'Flat', bandGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0, trebleDb: 0 },
  { id: 'rock', label: 'Rock', bandGainsDb: [4, 3, 2, 1, -1, -2, -1, 0, 2, 4], bassDb: 0, trebleDb: 0 },
  { id: 'pop', label: 'Pop', bandGainsDb: [-2, -1, 1, 3, 4, 4, 2, 1, 0, -1], bassDb: 0, trebleDb: 0 },
  { id: 'jazz', label: 'Jazz', bandGainsDb: [3, 2, 1, 0, -1, 0, 1, 2, 3, 4], bassDb: 0, trebleDb: 0 },
  { id: 'classical', label: 'Classical', bandGainsDb: [4, 3, 2, 1, -1, -1, 1, 2, 3, 4], bassDb: 0, trebleDb: 0 },
  { id: 'dance', label: 'Dance', bandGainsDb: [6, 4, 2, 0, -2, -2, 0, 2, 4, 6], bassDb: 3, trebleDb: 0 },
  { id: 'bass', label: 'Bass Booster', bandGainsDb: [6, 5, 4, 3, 1, -1, -2, -2, -3, -3], bassDb: 4, trebleDb: 0 },
  { id: 'treble', label: 'Treble Booster', bandGainsDb: [-3, -3, -2, -2, -1, 1, 3, 4, 5, 6], bassDb: 0, trebleDb: 4 },
  { id: 'vocal', label: 'Vocal', bandGainsDb: [-2, -2, -1, 1, 3, 4, 4, 2, 0, -2], bassDb: 0, trebleDb: 0 }
]

export function eqPresetById(id: string): EqPreset | undefined {
  return EQ_PRESETS.find((preset) => preset.id === id)
}
