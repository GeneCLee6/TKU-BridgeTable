import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import type { Seat, Suit } from '../../shared/cards.ts'
import { AuctionBox } from '../../src/components/AuctionBox.tsx'
import { HandView } from '../../src/components/HandView.tsx'
import { CallLabel, SuitSymbol } from '../../src/components/Suit.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { AUCTION, CALLS, DEAL, SUITS } from '../shared-display/cases.ts'

/**
 * The table draws suits, calls, an auction and a deal as 淡江橋館 does (BridgeHall e7-t07, AC-7.5):
 * the cases in tests/shared-display/cases.ts, the same file in both repositories
 */

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('the display shared with 淡江橋館', () => {
  it('draws each suit with its symbol and name', () => {
    for (const { suit, symbol, name } of SUITS) {
      const { unmount } = wrap(<SuitSymbol suit={suit} />)
      expect(screen.getByRole('img', { name })).toHaveTextContent(symbol)
      unmount()
    }
  })

  it('draws every call the same', () => {
    for (const [call, text] of CALLS) {
      const { container, unmount } = wrap(<CallLabel call={call} />)
      expect(container.textContent).toBe(text)
      unmount()
    }
  })

  it('draws an auction in the same rows, West to South', () => {
    const seats: Seat[] = ['N', 'E', 'S', 'W']
    const start = seats.indexOf(AUCTION.dealer)
    const auction: AuctionCall[] = AUCTION.calls.map((call, i) => ({ seat: seats[(start + i) % 4], call }))
    wrap(<AuctionBox auction={auction} dealer={AUCTION.dealer} vul="None" viewer="S" />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent))).toEqual(AUCTION.rows)
  })

  it('draws each hand of a deal suit by suit, a void as a dash', () => {
    for (const seat of ['N', 'E', 'S', 'W'] as const) {
      const { unmount } = wrap(<HandView cards={[...DEAL.hands[seat]]} count={13} width={60} style="text" label={seat} />)
      const hand = screen.getByRole('group', { name: seat })
      const drawn: Record<string, string[]> = {}
      for (const row of Array.from(hand.children)) {
        const suit = SUITS.find((s) => s.name === within(row as HTMLElement).getByRole('img').getAttribute('aria-label'))!.suit
        const ranks = within(row as HTMLElement).queryAllByRole('button').map((b) => b.textContent)
        drawn[suit] = ranks
        if (!ranks.length) expect(row).toHaveTextContent(DEAL.void)
      }
      expect(drawn).toEqual(DEAL.drawn[seat] as Record<Suit, readonly string[]>)
      unmount()
    }
  })
})
