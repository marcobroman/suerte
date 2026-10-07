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

  const sideControl = (
    label: string,
    value: number,
    min: number,
    max: number,
    sliderLabel: string,
    onPick: (value: number) => void
  ) => (
    <div key={label} className="eq-side-control">
      <div className="eq-side-label">
        <span>{label}</span>
        <span className="eq-value">{formatDb(value)}</span>
      </div>
      <Slider value={value} min={min} max={max} step={0.5} label={sliderLabel} onChange={onPick} />
    </div>
  )

  return (
    <section className="eq-panel" aria-label="Equalizer">
      <header className="eq-head">
        <h2>Equalizer</h2>
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

      <div className="eq-body">
        <div className="eq-main">
          <EqCurvePlot
            eq={eq}
            onBandGain={(index, gainDb) => setBand(index, gainDb)}
            onBandReset={(index) => setBand(index, 0)}
          />

          <p className="eq-hint">Drag the nodes on the curve — double-click one to reset its band.</p>
        </div>

        <aside className="eq-side" aria-label="Tone and headroom">
          <h3>Tone &amp; headroom</h3>
          {sideControl('Pre', eq.preampDb, PREAMP_MIN_DB, PREAMP_MAX_DB, 'Preamp', (preampDb) =>
            onChange({ preampDb })
          )}
          {sideControl('Bass', eq.bassDb, SHELF_GAIN_MIN_DB, SHELF_GAIN_MAX_DB, 'Bass shelf', (bassDb) =>
            onChange({ bassDb })
          )}
          {sideControl(
            'Treble',
            eq.trebleDb,
            SHELF_GAIN_MIN_DB,
            SHELF_GAIN_MAX_DB,
            'Treble shelf',
            (trebleDb) => onChange({ trebleDb })
          )}
          <label className="eq-check" title="Keeps boosted EQ from clipping the output">
            <input
              type="checkbox"
              checked={eq.autoPreamp}
              onChange={(event) => onChange({ autoPreamp: event.target.checked })}
            />{' '}
            Auto preamp
          </label>
        </aside>
      </div>
    </section>
  )
}
