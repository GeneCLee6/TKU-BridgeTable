import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ThemeProvider } from 'styled-components'
import { createTheme, type DeckColors, type ThemeMode } from '../styles/tokens.ts'

/**
 * Per-viewer display preferences: light/dark chrome and a two- or four-colour deck (BBO offers
 * both; two-colour is its default). Remembered in localStorage when it is available.
 */

interface Preferences {
  mode: ThemeMode
  deck: DeckColors
  toggleMode: () => void
  toggleDeck: () => void
}

const PreferencesContext = createContext<Preferences | null>(null)

const STORAGE_KEY = 'tku-bridge-table:prefs'

function readStored(): Partial<{ mode: ThemeMode; deck: DeckColors }> {
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

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => readStored().mode ?? systemMode())
  const [deck, setDeck] = useState<DeckColors>(() => readStored().deck ?? 'two')

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode, deck }))
    } catch {
      // Private mode or blocked storage: the preference simply is not remembered.
    }
  }, [mode, deck])

  const toggleMode = useCallback(() => setMode((m) => (m === 'light' ? 'dark' : 'light')), [])
  const toggleDeck = useCallback(() => setDeck((d) => (d === 'two' ? 'four' : 'two')), [])

  const theme = useMemo(() => createTheme(mode, deck), [mode, deck])
  const value = useMemo(() => ({ mode, deck, toggleMode, toggleDeck }), [mode, deck, toggleMode, toggleDeck])

  return (
    <PreferencesContext.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </PreferencesContext.Provider>
  )
}

// The hook belongs next to its provider; fast refresh of this file reloads the page, which is fine.
// oxlint-disable-next-line react/only-export-components
export function usePreferences(): Preferences {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error('usePreferences must be used inside PreferencesProvider')
  return ctx
}
