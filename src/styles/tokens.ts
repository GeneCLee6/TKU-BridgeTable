/**
 * Design tokens. Every colour in the app comes from here (DESIGN.md §2 explains each one).
 * Components read them through the styled-components theme, never as raw hex values.
 *
 * The chrome (header, lobby, history) follows the light/dark theme and the TKU palette shared
 * with TKU BridgeBook. The table itself follows BBO: green felt, white cards, the bidding box
 * colours and red name plates for the vulnerable side. Those stay the same in both themes.
 */

export type ThemeMode = 'light' | 'dark'
export type DeckColors = 'two' | 'four'

const palette = {
  light: {
    bg: '#f4f6fa',
    surface: '#ffffff',
    surfaceAlt: '#eef2f8',
    border: '#d5dce8',
    text: '#1a2233',
    textMuted: '#4f5a70',
    primary: '#0f3d7a',
    primaryStrong: '#0a2b57',
    primarySoft: '#e3ecf8',
    onPrimary: '#ffffff',
    lantern: '#d9a330',
    vermilion: '#b8321f',
    focus: '#2f6fd6',
    danger: '#b3261e',
    dangerSoft: '#fdeceb',
    success: '#1b7a33',
    overlay: 'rgba(10, 20, 40, 0.45)',
  },
  dark: {
    bg: '#0d1320',
    surface: '#151d2c',
    surfaceAlt: '#1c2637',
    border: '#2c3850',
    text: '#e6ebf3',
    textMuted: '#a3afc4',
    primary: '#8db8ff',
    primaryStrong: '#b5d0ff',
    primarySoft: '#1b2c4a',
    onPrimary: '#0d1320',
    lantern: '#e7b850',
    vermilion: '#ff8a70',
    focus: '#8db8ff',
    danger: '#ff8a80',
    dangerSoft: '#3b1d1d',
    success: '#5fd27a',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
} as const

/** Suit colours on the chrome (history tables, lobby) */
const suits = {
  light: { S: '#1a2233', H: '#c8102e', D: '#b34700', C: '#1b7a33' },
  dark: { S: '#e6ebf3', H: '#ff6b6b', D: '#ffa04d', C: '#5fd27a' },
} as const

/** The table, modelled on BBO; identical in light and dark mode */
const table = {
  felt: '#1f6b43',
  feltEdge: '#154d30',
  feltText: '#f1f7f2',
  feltMuted: '#b8d4c1',
  /** A darker patch of felt: the last-trick window, a hovered trick pile */
  feltDeep: '#134229',
  shade: 'rgba(0, 0, 0, 0.18)',
  panel: '#f7f8f4',
  panelText: '#1d2420',
  panelMuted: '#5b665e',
  panelBorder: '#c9cfc6',
  cardFace: '#ffffff',
  cardBorder: '#8d959c',
  cardBack: '#1d4f91',
  cardBackStripe: '#2f68b3',
  cardDisabled: 'rgba(0, 0, 0, 0.16)',
  plate: '#f7f8f4',
  plateText: '#1d2420',
  plateVul: '#c62828',
  plateVulText: '#ffffff',
  turn: '#ffd43b',
  alert: '#ffe066',
  alertField: '#fffbe6',
  bidPass: '#2f9e44',
  bidDouble: '#d9372b',
  bidRedouble: '#2b6fd6',
  bidAlert: '#f2c230',
  bidButton: '#ffffff',
  bidButtonText: '#1d2420',
  bidSelected: '#ffd43b',
  bidDisabled: '#c9cfc6',
  winner: '#ffd43b',
} as const

/** Suit colours printed on the cards: two-colour like BBO's default, or four-colour */
const cardSuits = {
  two: { S: '#111111', H: '#d10f1f', D: '#d10f1f', C: '#111111' },
  four: { S: '#111111', H: '#d10f1f', D: '#e06900', C: '#18852f' },
} as const

export const fonts = {
  body: `'Noto Sans TC Variable', 'Noto Sans TC', 'PingFang TC', 'Microsoft JhengHei', system-ui, sans-serif`,
  cards: `'Segoe UI', 'Helvetica Neue', Arial, sans-serif`,
  symbols: `'Segoe UI Symbol', 'Apple Symbols', 'Noto Sans Symbols 2', sans-serif`,
}

export const layout = {
  headerHeight: '56px',
  contentMax: '1080px',
  sidePanelWidth: '300px',
  mobileBreakpoint: '900px',
}

/** 4px spacing scale: space(2) === '8px' */
export const space = (n: number) => `${n * 4}px`

export function createTheme(mode: ThemeMode, deck: DeckColors) {
  return {
    mode,
    colors: palette[mode],
    suits: suits[mode],
    table,
    cardSuits: cardSuits[deck],
    fonts,
    layout,
    space,
    radius: { sm: '6px', md: '10px', lg: '14px', pill: '999px' },
    shadow:
      mode === 'light'
        ? '0 1px 2px rgba(15, 40, 80, 0.06), 0 2px 8px rgba(15, 40, 80, 0.06)'
        : '0 1px 2px rgba(0, 0, 0, 0.4)',
    cardShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
  }
}

export type AppTheme = ReturnType<typeof createTheme>

/** The phone layout breakpoint, for useMediaQuery */
export const mobileQuery = `(max-width: ${layout.mobileBreakpoint})`

/** Media query helper: `${mobile} { ... }` */
export const mobile = `@media ${mobileQuery}`
