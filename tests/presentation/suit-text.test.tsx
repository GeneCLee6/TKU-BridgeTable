import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SuitText } from '../../src/components/Suit.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { createTheme } from '../../src/styles/tokens.ts'

/** Suit symbols in a call's explanation take the suit colours of the deck setting (W4) */

const TEXT = '迫伴賭倍：0–2 張♠，3+ 張♥，3+ 張♦，3+ 張♣，12+ 大牌點'

function show(deck: 'two' | 'four', onCard: boolean, mode: 'light' | 'dark' = 'light') {
  window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'zh', tableTourSeen: true, deck, mode }))
  render(
    <PreferencesProvider>
      <p data-testid="text">
        <SuitText text={TEXT} onCard={onCard} />
      </p>
    </PreferencesProvider>,
  )
  const p = screen.getByTestId('text')
  const color = (symbol: string) => getComputedStyle([...p.querySelectorAll('span')].find((s) => s.textContent === symbol)!).color
  return { p, color }
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`
}

describe('SuitText', () => {
  it('keeps the words as they are, so a screen reader reads the same text', () => {
    const { p } = show('four', true)
    expect(p).toHaveTextContent(TEXT)
    expect(p.querySelectorAll('span')).toHaveLength(4)
    expect(p.querySelector('[role="img"], [aria-label]')).toBeNull()
  })

  it('uses the card colours on the table, two- or four-colour', () => {
    const four = createTheme('light', 'four').cardSuits
    let { color } = show('four', true)
    expect(color('♦')).toBe(rgb(four.D))
    expect(color('♣')).toBe(rgb(four.C))
    document.body.innerHTML = ''
    const two = createTheme('light', 'two').cardSuits
    ;({ color } = show('two', true))
    expect(color('♦')).toBe(rgb(two.D))
    expect(color('♣')).toBe(rgb(two.C))
    expect(color('♦')).toBe(color('♥'))
  })

  it('on the chrome follows the theme and folds to two colours with a two-colour deck', () => {
    const dark = createTheme('dark', 'four').suits
    let { color } = show('four', false, 'dark')
    expect(color('♠')).toBe(rgb(dark.S))
    expect(color('♦')).toBe(rgb(dark.D))
    document.body.innerHTML = ''
    ;({ color } = show('two', false, 'dark'))
    expect(color('♦')).toBe(rgb(dark.H))
    expect(color('♣')).toBe(rgb(dark.S))
  })

  it('leaves text without suit symbols alone', () => {
    render(
      <PreferencesProvider>
        <p data-testid="plain">
          <SuitText text="止叫" />
        </p>
      </PreferencesProvider>,
    )
    expect(screen.getByTestId('plain').innerHTML).toBe('止叫')
  })
})
