import type { EqSettings } from '@shared/types'
import { Slider } from '../Slider'
import { PREAMP_MAX_DB, PREAMP_MIN_DB, SHELF_GAIN_MAX_DB, SHELF_GAIN_MIN_DB, formatDb } from '../audio/db'
import { EqCurvePlot } from './EqCurvePlot'
import { EQ_PRESETS } from './eqPresets'

export interface EqPanelProps {
  readonly eq: EqSettings
  readonly activePresetId: string | null
  onChange(patch: Partial<EqSettings>): void
  onPreset(presetId: string): void
  onReset(): void
}

/**
 * Graphic equalizer drawer: the curve is the control surface — drag its nodes —
 * with presets and the tone/headroom controls around it.
 */
export function EqPanel({ eq, activePresetId, onChange, onPreset, onReset }: EqPanelProps) {
  const setBand = (index: number, gainDb: number): void => {
    const bandGainsDb = [...eq.bandGainsDb]
    bandGainsDb[index] = gainDb
    onChange({ bandGainsDb })
  }

  const activePreset = EQ_PRESETS.find((preset) => preset.id === activePresetId)

  return (
    <section className="eq-panel" aria-label="Equalizer">
      <header className="eq-head">
        <h2>
          Equalizer
          {activePreset && <span className="eq-preset-name"> · {activePreset.label}</span>}
        </h2>
        <div className="eq-head-actions">
          <select
            className="sort-select"
            value={activePresetId ?? ''}
            onChange={(event) => {
              if (event.target.value !== '') onPreset(event.target.value)
            }}
            aria-label="EQ preset"
          >
            <option value="">Preset…</option>
            {EQ_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          <button type="button" className="ghost-button" onClick={onReset}>
            Reset
          </button>
        </div>
      </header>

      <EqCurvePlot
        eq={eq}
        onBandGain={(index, gainDb) => setBand(index, gainDb)}
        onBandReset={(index) => setBand(index, 0)}
      />

      <p className="eq-hint">Drag the nodes on the curve — double-click one to reset its band.</p>

      <details className="eq-advanced">
        <summary>Tone &amp; headroom</summary>
        <div className="eq-row">
          <span className="eq-label">Pre</span>
          <Slider
            value={eq.preampDb}
            min={PREAMP_MIN_DB}
            max={PREAMP_MAX_DB}
            step={0.5}
            label="Preamp"
            onChange={(preampDb) => onChange({ preampDb })}
          />
          <span className="eq-value">{formatDb(eq.preampDb)}</span>
        </div>
        <div className="eq-row">
          <span className="eq-label">Bass</span>
          <Slider
            value={eq.bassDb}
            min={SHELF_GAIN_MIN_DB}
            max={SHELF_GAIN_MAX_DB}
            step={0.5}
            label="Bass shelf"
            onChange={(bassDb) => onChange({ bassDb })}
          />
          <span className="eq-value">{formatDb(eq.bassDb)}</span>
        </div>
        <div className="eq-row">
          <span className="eq-label">Treble</span>
          <Slider
            value={eq.trebleDb}
            min={SHELF_GAIN_MIN_DB}
            max={SHELF_GAIN_MAX_DB}
            step={0.5}
            label="Treble shelf"
            onChange={(trebleDb) => onChange({ trebleDb })}
          />
          <span className="eq-value">{formatDb(eq.trebleDb)}</span>
        </div>
        <label className="eq-check">
          <input
            type="checkbox"
            checked={eq.autoPreamp}
            onChange={(event) => onChange({ autoPreamp: event.target.checked })}
          />{' '}
          Auto preamp (prevents clipping)
        </label>
      </details>
    </section>
  )
}
