import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeProvider } from 'styled-components'
import { formatMessage, isLang, isMessageCode, type Lang, type MessageParams } from '../../shared/messages.ts'
import { isCardSize, type CardSize } from '../lib/cards.ts'
import { DEFAULT_SOUND_PREFS, SOUND_STYLES, SOUND_VOLUMES, type SoundPrefs, type SoundStyle, type SoundVolume } from '../lib/sound/events.ts'
import { STRINGS, type Strings } from '../strings.ts'
import { createTheme, type DeckColors, type ThemeMode } from '../styles/tokens.ts'

/**
 * Per-viewer display preferences: language, light/dark, a two- or four-colour deck, whether hands
 * are drawn as card faces or as text (♠ A K Q, BBO's text style), table sounds (on or off, their
 * style, volume, which kinds play and a phone's vibration; DESIGN.md §4「音效」), and whether a
 * board record's replay greys out the cards already played (BBO's Handviewer) or takes them out of
 * the hands, whether a call or a card must be confirmed before it is sent (BBO's "confirm bids" and
 * "confirm cards"), how large the cards are drawn, and whether the table tour has been seen. Remembered in localStorage when it is
 * available.
 */

export type CardStyle = 'cards' | 'text'
export type PlayedCards = 'grey' | 'hide'
export type { CardSize }

interface Prefs extends SoundPrefs {
  mode: ThemeMode
  deck: DeckColors
  lang: Lang
  cardStyle: CardStyle
  playedCards: PlayedCards
  confirmCalls: boolean
  confirmPlays: boolean
  cardSize: CardSize
  /** The table tour has been seen (or skipped); "My account" can show it again (e3-t34) */
  tableTourSeen: boolean
}

interface Preferences extends Prefs {
  set: (change: Partial<Prefs>) => void
  toggleMode: () => void
  toggleDeck: () => void
  toggleCardStyle: () => void
  toggleSound: () => void
  t: Strings
  /** A server message code in the current language */
  message: (code: string, params?: MessageParams, fallback?: string) => string
}

const PreferencesContext = createContext<Preferences | null>(null)

const STORAGE_KEY = 'tku-bridge-table:prefs'

function readStored(): Partial<Prefs> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function systemMode(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** Traditional Chinese unless the browser asks for another language the site speaks (else English) */
function systemLang(): Lang {
  try {
    const wanted = navigator.language.toLowerCase()
    if (!wanted) return 'zh'
    if (wanted.startsWith('zh')) return /hans|cn|sg/.test(wanted) ? 'zh-Hans' : 'zh'
    const base = wanted.split('-')[0]
    return isLang(base) ? base : 'en'
  } catch {
    return 'zh'
  }
}

/** The `lang` attribute of the page for each language */
const HTML_LANG: Record<Lang, string> = { zh: 'zh-Hant-TW', 'zh-Hans': 'zh-Hans-CN', en: 'en', vi: 'vi', ja: 'ja', ko: 'ko' }

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const stored = readStored()
    return {
      mode: stored.mode ?? systemMode(),
      deck: stored.deck ?? 'two',
      lang: isLang(stored.lang) ? stored.lang : systemLang(),
      cardStyle: stored.cardStyle ?? 'cards',
      sound: stored.sound ?? DEFAULT_SOUND_PREFS.sound,
      soundStyle: SOUND_STYLES.includes(stored.soundStyle as SoundStyle) ? stored.soundStyle! : DEFAULT_SOUND_PREFS.soundStyle,
      soundVolume: SOUND_VOLUMES.includes(stored.soundVolume as SoundVolume) ? stored.soundVolume! : DEFAULT_SOUND_PREFS.soundVolume,
      soundBids: typeof stored.soundBids === 'boolean' ? stored.soundBids : DEFAULT_SOUND_PREFS.soundBids,
      soundChat: typeof stored.soundChat === 'boolean' ? stored.soundChat : DEFAULT_SOUND_PREFS.soundChat,
      soundKibitz: typeof stored.soundKibitz === 'boolean' ? stored.soundKibitz : DEFAULT_SOUND_PREFS.soundKibitz,
      vibrate: stored.vibrate === true,
      playedCards: stored.playedCards === 'hide' ? 'hide' : 'grey',
      confirmCalls: stored.confirmCalls === true,
      confirmPlays: stored.confirmPlays === true,
      cardSize: isCardSize(stored.cardSize) ? stored.cardSize : 'medium',
      tableTourSeen: stored.tableTourSeen === true,
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch {
      // Private mode or blocked storage: the preference simply is not remembered.
    }
    document.documentElement.lang = HTML_LANG[prefs.lang]
  }, [prefs])

  const set = useCallback((change: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...change })), [])
  const value = useMemo<Preferences>(() => {
    const t = STRINGS[prefs.lang]
    return {
      ...prefs,
      set,
      toggleMode: () => set({ mode: prefs.mode === 'light' ? 'dark' : 'light' }),
      toggleDeck: () => set({ deck: prefs.deck === 'two' ? 'four' : 'two' }),
      toggleCardStyle: () => set({ cardStyle: prefs.cardStyle === 'cards' ? 'text' : 'cards' }),
      // The speaker button: off silences everything; on again also brings back a style turned off
      toggleSound: () =>
        prefs.sound && prefs.soundStyle !== 'off'
          ? set({ sound: false })
          : set({ sound: true, soundStyle: prefs.soundStyle === 'off' ? DEFAULT_SOUND_PREFS.soundStyle : prefs.soundStyle }),
      t,
      message: (code, params, fallback) =>
        isMessageCode(code) ? formatMessage(code, prefs.lang, params) : (fallback ?? t.genericError),
    }
  }, [prefs, set])

  const theme = useMemo(() => createTheme(prefs.mode, prefs.deck), [prefs.mode, prefs.deck])

  return (
    <PreferencesContext.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </PreferencesContext.Provider>
  )
}

// The hooks belong next to their provider; fast refresh of this file reloads the page, which is fine.
// oxlint-disable-next-line react/only-export-components
export function usePreferences(): Preferences {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error('usePreferences must be used inside PreferencesProvider')
  return ctx
}

/** The UI strings in the viewer's language */
// oxlint-disable-next-line react/only-export-components
export function useT(): Strings {
  return usePreferences().t
}
