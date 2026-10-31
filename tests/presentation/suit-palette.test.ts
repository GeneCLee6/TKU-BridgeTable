import { describe, expect, it } from 'vitest'
import { createTheme, suitColours, type DeckColors, type ThemeMode } from '../../src/styles/tokens.ts'

/** One suit palette on every page (Y1, DESIGN.md §2.3): every suit readable on every surface it is drawn on */

/** WCAG 2 contrast ratio of two #rrggbb colours */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16)
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const SUITS = ['S', 'H', 'D', 'C'] as const
const DECKS: DeckColors[] = ['two', 'four']
const THEMES: ThemeMode[] = ['light', 'dark']

/** The surfaces suits are drawn on, by theme: the chrome's, and the table's (light in both themes) */
function surfaces(mode: ThemeMode) {
  const { colors, table } = createTheme(mode, 'four')
  return {
    chrome: { bg: colors.bg, surface: colors.surface, surfaceAlt: colors.surfaceAlt, primarySoft: colors.primarySoft },
    table: { cardFace: table.cardFace, panel: table.panel, plate: table.plate, bidButton: table.bidButton, alertField: table.alertField },
    /** Yellow highlights behind large symbols: a selected call, an alerted cell, a playable card in text mode */
    yellows: { bidSelected: table.bidSelected, alert: table.alert, turn: table.turn },
  }
}

describe('suit palette', () => {
  for (const mode of THEMES)
    for (const deck of DECKS) {
      const theme = createTheme(mode, deck)
      const { chrome, table, yellows } = surfaces(mode)

      it(`${mode} ${deck}-colour: 4.5:1 or better on the chrome`, () => {
        for (const suit of SUITS)
          for (const [name, bg] of Object.entries(chrome))
            expect(contrast(theme.suits[suit], bg), `${suit} on ${name}`).toBeGreaterThanOrEqual(4.5)
      })

      it(`${mode} ${deck}-colour: 4.5:1 or better on the table's cards and panels`, () => {
        for (const suit of SUITS)
          for (const [name, bg] of Object.entries(table))
            expect(contrast(theme.cardSuits[suit], bg), `${suit} on ${name}`).toBeGreaterThanOrEqual(4.5)
      })

      it(`${mode} ${deck}-colour: 3:1 or better on the table's yellows (large symbols)`, () => {
        for (const suit of SUITS)
          for (const [name, bg] of Object.entries(yellows))
            expect(contrast(theme.cardSuits[suit], bg), `${suit} on ${name}`).toBeGreaterThanOrEqual(3)
      })
    }

  it('uses one hue per suit: the table and the light chrome share the colours, two-colour folds ♦ to ♥ and ♣ to ♠', () => {
    for (const deck of DECKS) {
      expect(createTheme('light', deck).suits).toEqual(createTheme('light', deck).cardSuits)
      expect(createTheme('dark', deck).cardSuits).toEqual(suitColours('light', deck))
    }
    for (const mode of THEMES) {
      const two = suitColours(mode, 'two')
      const four = suitColours(mode, 'four')
      expect(two).toEqual({ S: four.S, H: four.H, D: four.H, C: four.S })
    }
  })

  it('keeps each suit the same hue in the dark theme, only lighter', () => {
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => c / 255)
      const max = Math.max(r, g, b)
      const d = max - Math.min(r, g, b)
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    const light = suitColours('light', 'four')
    const dark = suitColours('dark', 'four')
    for (const suit of ['H', 'D', 'C'] as const) expect(Math.abs(hue(light[suit]) - hue(dark[suit])), suit).toBeLessThan(4)
  })
})
