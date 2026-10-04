import { DEFAULT_THEME, isThemeId, type ThemeId } from '@shared/types'

export interface ThemeOption {
  readonly id: ThemeId
  readonly label: string
  /** Three colours shown on the picker button, matching the stylesheet. */
  readonly swatches: readonly [string, string, string]
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'spotlight', label: 'Spotlight', swatches: ['#000000', '#181818', '#1db954'] },
  { id: 'midnight', label: 'Midnight', swatches: ['#070b14', '#141c2e', '#6ea8fe'] },
  { id: 'daylight', label: 'Daylight', swatches: ['#ffffff', '#eaeaea', '#1a7f37'] },
  { id: 'ember', label: 'Ember', swatches: ['#0d0a09', '#1d1714', '#ff7a45'] },
  { id: 'forest', label: 'Forest', swatches: ['#060d09', '#101b14', '#34d399'] },
  { id: 'violet', label: 'Violet', swatches: ['#0c0913', '#191430', '#a78bfa'] },
  { id: 'rose', label: 'Rose', swatches: ['#120a0e', '#23141d', '#fb7185'] },
  { id: 'sand', label: 'Sand', swatches: ['#fdfaf3', '#efe7d6', '#b45309'] }
]

/** Falls back to the default so an unknown id never leaves the app unstyled. */
export function resolveTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME
}

/**
 * Structurally just an element's dataset, declared without DOM types so the
 * node-side test program can import this module. `HTMLElement` satisfies it.
 */
export interface ThemeTarget {
  dataset: Record<string, string | undefined>
}

/**
 * The stylesheet keys every colour off `[data-theme]`, so switching is one attribute
 * write rather than re-rendering the tree.
 */
export function applyTheme(theme: ThemeId, root: ThemeTarget): void {
  root.dataset.theme = theme
}