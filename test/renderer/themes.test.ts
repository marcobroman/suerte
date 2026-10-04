import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, THEME_IDS, isThemeId } from '@shared/types'
import { applyTheme, resolveTheme, THEME_OPTIONS, type ThemeTarget } from '@/library/themes'

describe('isThemeId', () => {
  it('accepts every declared theme', () => {
    for (const id of THEME_IDS) expect(isThemeId(id)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isThemeId('neon')).toBe(false)
    expect(isThemeId('')).toBe(false)
    expect(isThemeId(7)).toBe(false)
    expect(isThemeId(null)).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
  })
})

describe('THEME_OPTIONS', () => {
  it('offers exactly one entry per theme, in order', () => {
    expect(THEME_OPTIONS.map((option) => option.id)).toEqual([...THEME_IDS])
  })

  it('gives every theme a label and three hex swatches', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.swatches).toHaveLength(3)
      for (const color of option.swatches) expect(color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('resolveTheme', () => {
  it('keeps a valid theme', () => {
    for (const id of THEME_IDS) expect(resolveTheme(id)).toBe(id)
  })

  it('falls back to the default for unknown values', () => {
    expect(resolveTheme('nope')).toBe(DEFAULT_THEME)
    expect(resolveTheme(undefined)).toBe(DEFAULT_THEME)
    expect(resolveTheme(3)).toBe(DEFAULT_THEME)
  })
})

describe('applyTheme', () => {
  // A dataset stub avoids pulling in a DOM implementation just to assert one write.
  const fakeRoot = (): ThemeTarget => ({ dataset: {} })

  it('writes the theme onto the element as a data attribute', () => {
    const root = fakeRoot()
    applyTheme('midnight', root)
    expect(root.dataset.theme).toBe('midnight')
  })

  it('replaces a previously applied theme', () => {
    const root = fakeRoot()
    applyTheme('ember', root)
    applyTheme('daylight', root)
    expect(root.dataset.theme).toBe('daylight')
  })
})