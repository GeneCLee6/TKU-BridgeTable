import { useEffect, useState } from 'react'
import type { Card } from '../../shared/cards.ts'

/**
 * Choosing the card to play, with the mouse or the keyboard.
 *
 * - With `confirm` (BBO's "confirm cards") the first click on a card lifts it and a second click
 *   plays it; clicking another card lifts that one instead. Without it a click plays at once.
 * - The left and right arrow keys move between the cards that may be played (`cards`, in the order
 *   they are drawn), and Enter plays the lifted card; Escape puts it back.
 *
 * `turn` names this chance to play (board and card number): the lifted card is forgotten when it
 * changes. Keys typed into a field (chat, alert) are left alone.
 */

/** Whether a key press belongs to a text field rather than the table */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function useCardChoice({
  cards,
  confirm,
  turn,
  onPlay,
}: {
  /** The cards that may be played now, in the order they are drawn; empty when it is not your turn */
  cards: readonly Card[]
  confirm: boolean
  turn: string
  onPlay: (card: Card) => void
}) {
  const [lifted, setLifted] = useState<{ card: Card; turn: string } | null>(null)
  const chosen = lifted && lifted.turn === turn && cards.includes(lifted.card) ? lifted.card : null

  const pick = (card: Card) => {
    if (confirm && chosen !== card) {
      setLifted({ card, turn })
      return
    }
    setLifted(null)
    onPlay(card)
  }

  useEffect(() => {
    if (!cards.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || typingIn(e.target)) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const at = chosen ? cards.indexOf(chosen) : -1
        const step = e.key === 'ArrowRight' ? 1 : -1
        const next = at < 0 ? (step > 0 ? 0 : cards.length - 1) : (at + step + cards.length) % cards.length
        setLifted({ card: cards[next], turn })
      } else if (e.key === 'Enter' && chosen) {
        // Also keeps a focused button from being clicked by the same key
        e.preventDefault()
        setLifted(null)
        onPlay(chosen)
      } else if (e.key === 'Escape' && chosen) {
        setLifted(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cards, chosen, turn, onPlay])

  return { chosen, pick }
}
