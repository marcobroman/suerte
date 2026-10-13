import type { ThemeId } from '@shared/types'
import { THEME_OPTIONS } from './themes'

export interface ThemeMenuProps {
  readonly current: ThemeId
  onSelect(theme: ThemeId): void
}

/** Theme picker section of the settings menu; selection persistence stays with the caller. */
export function ThemeMenu({ current, onSelect }: ThemeMenuProps) {
  return (
    <>
      <p className="settings-label">Theme</p>
      {THEME_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemradio"
          aria-checked={option.id === current}
          className={option.id === current ? 'settings-item active' : 'settings-item'}
          onClick={() => onSelect(option.id)}
        >
          <span className="swatch-colors small" aria-hidden="true">
            {option.swatches.map((color) => (
              <span key={color} style={{ background: color }} />
            ))}
          </span>
          {option.label}
        </button>
      ))}
    </>
  )
}
