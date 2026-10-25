/**
 * Design tokens. Every colour in the app comes from here (DESIGN.md §2 explains each one).
 * Components read them through the styled-components theme, never as raw hex values.
 *
 * The chrome (header, lobby, history, forms) follows the light/dark theme: navy, off-white and a
 * single lantern-gold accent (DESIGN.md §2.1), shared with TKU BridgeBook. The table itself follows BBO: green felt, white cards, the bidding box
 * colours and red name plates for the vulnerable side. Those stay the same in both themes.
 */

export type ThemeMode = 'light' | 'dark'
export type DeckColors = 'two' | 'four'

const palette = {
  light: {
    /** Off-white page background */
    bg: '#f6f3ec',
    /** Cards, inputs */
    surface: '#fffdf9',
    /** Table heads, card footers, disabled inputs, skeletons */
    surfaceAlt: '#efeae0',
    /** Card edges and dividers (decorative) */
    border: '#e2dbcd',
    /** Input and secondary-button outlines: 3:1 on surface */
    borderStrong: '#9c9282',
    text: '#1b2333',
    textMuted: '#5a6170',
    /** Navy: primary buttons, links */
    primary: '#1c2e4f',
    /** The primary button on hover */
    primaryHover: '#26406b',
    /** @deprecated Headings use `text`; the primary button's hover uses `primaryHover`. Kept for older components. */
    primaryStrong: '#1c2e4f',
    primarySoft: '#e6eaf1',
    onPrimary: '#fdfaf3',
    /** The page header: navy with off-white text */
    header: '#16243f',
    onHeader: '#f3efe6',
    headerMuted: '#aab4c8',
    /** A hovered link or icon in the header */
    headerHover: 'rgba(243, 239, 230, 0.1)',
    /** ♥♦ in the header's tagline, readable on navy */
    headerSuitRed: '#ff8f80',
    /** Lantern gold: rules, the selected tab's underline, badge backgrounds. Not a text colour on light. */
    accent: '#c9972e',
    /** Gold when it has to be text (badge labels) */
    accentStrong: '#8a6414',
    accentSoft: '#f6ebd2',
    /** @deprecated Same as `accent` */
    lantern: '#c9972e',
    vermilion: '#b8321f',
    focus: '#3b6fd1',
    danger: '#b3261e',
    dangerSoft: '#fbeceb',
    /** Text on a solid danger button */
    onDanger: '#ffffff',
    success: '#1f7a3d',
    successSoft: '#e6f2e9',
    overlay: 'rgba(10, 20, 40, 0.45)',
  },
  dark: {
    bg: '#0e1420',
    surface: '#161e2d',
    surfaceAlt: '#1d2738',
    border: '#2d3a50',
    borderStrong: '#627089',
    text: '#ece7dc',
    textMuted: '#a6afbf',
    primary: '#a9c0e6',
    primaryHover: '#c3d4f0',
    primaryStrong: '#ece7dc',
    primarySoft: '#1f2d45',
    onPrimary: '#0e1420',
    header: '#0a101b',
    onHeader: '#ece7dc',
    headerMuted: '#8f9ab0',
    headerHover: 'rgba(236, 231, 220, 0.08)',
    headerSuitRed: '#ff8f80',
    accent: '#e0b255',
    accentStrong: '#e0b255',
    accentSoft: '#3a2f17',
    lantern: '#e0b255',
    vermilion: '#ff8a70',
    focus: '#8db8ff',
    danger: '#ff8a80',
    dangerSoft: '#3b1d1d',
    onDanger: '#0e1420',
    success: '#6fd18a',
    successSoft: '#17301f',
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
  /** A card already played, still shown in the hand in a board record (BBO's Handviewer) */
  cardPlayed: 'rgba(120, 128, 124, 0.62)',
  playedText: '#b3bab5',
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
  /** The crown before the host's name */
  crown: '#e0a100',
  /** The countdown ring before the next deal */
  ring: '#2f9e44',
  ringTrack: '#d9ded6',
} as const

/**
 * Default avatars (e1-t18): the initial on one of these, picked from the member's id so it never
 * changes. All carry `onAvatar` text at 4.5:1 or better, and look the same in both themes
 */
const avatars = ['#1c2e4f', '#7a3b12', '#1f6b43', '#5b2c7a', '#a0302a', '#2a5d8f', '#6e5410', '#3d5a40', '#7a2a55', '#3f4a5c'] as const
const onAvatar = '#ffffff'

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
  /** Tablets (e3-t36): above the phone layout, up to this width */
  tabletBreakpoint: '1200px',
  /** Below this the header leaves out the wordmark beside the logo, so the links fit */
  compactHeaderBreakpoint: '1400px',
}

/** 4px spacing scale: space(2) === '8px'. The chrome uses 1, 2, 3, 4, 6, 8 and 12. */
export const space = (n: number) => `${n * 4}px`

/** The chrome's type scale (DESIGN.md §3): components use only these */
export const type = {
  title: { size: '24px', line: '32px', weight: 700 },
  h2: { size: '18px', line: '26px', weight: 700 },
  h3: { size: '16px', line: '24px', weight: 700 },
  body: { size: '15px', line: '24px', weight: 400 },
  small: { size: '13px', line: '20px', weight: 400 },
  caption: { size: '12px', line: '16px', weight: 600 },
} as const

/** Heights shared by buttons and inputs, so a field and its button line up */
export const controlHeight = { sm: '32px', md: '40px', lg: '48px' } as const
export type ControlSize = keyof typeof controlHeight

export function createTheme(mode: ThemeMode, deck: DeckColors) {
  return {
    mode,
    colors: palette[mode],
    suits: suits[mode],
    table,
    cardSuits: cardSuits[deck],
    avatars,
    onAvatar,
    fonts,
    layout,
    space,
    type,
    controlHeight,
    /** sm: buttons, inputs · md: menus, toasts · lg: cards · pill: count badges only */
    radius: { sm: '6px', md: '8px', lg: '12px', pill: '999px' },
    /** Cards: one faint layer */
    shadow:
      mode === 'light'
        ? '0 1px 2px rgba(27, 35, 51, 0.05), 0 2px 6px rgba(27, 35, 51, 0.04)'
        : '0 1px 2px rgba(0, 0, 0, 0.4)',
    /** Floating layers: menus, toasts, dialogs */
    shadowRaised:
      mode === 'light'
        ? '0 4px 12px rgba(27, 35, 51, 0.12), 0 12px 32px rgba(27, 35, 51, 0.1)'
        : '0 4px 12px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.4)',
    cardShadow: '0 1px 3px rgba(0, 0, 0, 0.35)',
  }
}

export type AppTheme = ReturnType<typeof createTheme>

/** The phone layout breakpoint, for useMediaQuery */
export const mobileQuery = `(max-width: ${layout.mobileBreakpoint})`

/** Media query helper: `${mobile} { ... }` */
export const mobile = `@media ${mobileQuery}`

/** Tablets, 901–1200px wide, either way up (e3-t36, DESIGN.md §5) */
export const tabletQuery = `(min-width: 901px) and (max-width: ${layout.tabletBreakpoint})`
export const tablet = `@media ${tabletQuery}`

/** Computers and tablets too narrow for the full header */
export const compactHeader = `@media (max-width: ${layout.compactHeaderBreakpoint})`
