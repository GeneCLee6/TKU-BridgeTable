import { useEffect, useState } from 'react'
import styled from 'styled-components'
import { sideOf, type Seat, type Side } from '../../shared/cards.ts'
import type { Trick } from '../../shared/game.ts'
import { CARD_RATIO } from '../lib/cards.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { TrickArea, type Position } from './TrickArea.tsx'

/**
 * The finished tricks, face down in the corner as on BBO: upright for a trick your side won,
 * sideways for one it lost, packed close together. Clicking the pile opens the last trick in a
 * small window just above it, away from the trick being played in the middle, and plays its four
 * cards again one at a time in the order they were played; clicking again (or Escape) closes it.
 */

/** Pause between the cards when the last trick is played again */
export const LAST_TRICK_STEP_MS = 450

const Wrap = styled.div`
  position: relative;
  max-width: 100%;
`

const Pile = styled.button<{ $h: number }>`
  display: flex;
  align-items: flex-end;
  max-width: 100%;
  min-height: ${({ $h }) => $h + 8}px;
  padding: 4px;
  border: 0;
  border-radius: 6px;
  background: none;

  &:not(:disabled) { cursor: pointer; }
  &:hover:not(:disabled), &[aria-expanded='true'] { background: ${({ theme }) => theme.table.shade}; }
`

const Mini = styled.span<{ $w: number; $h: number }>`
  flex: none;
  width: ${({ $w }) => $w}px;
  height: ${({ $h }) => $h}px;
  border: 2px solid ${({ theme }) => theme.table.cardFace};
  border-radius: 3px;
  background: repeating-linear-gradient(
    45deg,
    ${({ theme }) => theme.table.cardBack} 0 4px,
    ${({ theme }) => theme.table.cardBackStripe} 4px 8px
  );
  box-shadow: ${({ theme }) => theme.cardShadow};
`

const Popup = styled.div`
  position: absolute;
  left: 0;
  bottom: calc(100% + 6px);
  z-index: 5;
  display: grid;
  justify-items: center;
  gap: 4px;
  padding: 6px 10px 10px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.feltDeep};
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  color: ${({ theme }) => theme.table.feltText};
  font-size: 14px;
  font-weight: 700;
`

/** The last trick, its cards coming out one by one */
function LastTrick({ trick, positionOf, width }: { trick: Trick; positionOf: (seat: Seat) => Position; width: number }) {
  const t = useT()
  const [shown, setShown] = useState(1)

  useEffect(() => {
    if (shown >= trick.cards.length) return
    const timer = setTimeout(() => setShown(shown + 1), LAST_TRICK_STEP_MS)
    return () => clearTimeout(timer)
  }, [shown, trick.cards.length])

  const complete = shown >= trick.cards.length
  return (
    <Popup role="dialog" aria-label={t.lastTrick}>
      <span>{t.lastTrick}</span>
      <TrickArea
        cards={trick.cards.slice(0, shown)}
        positionOf={positionOf}
        winner={complete ? trick.winner : undefined}
        width={width}
        label={t.lastTrick}
      />
    </Popup>
  )
}

export function TrickPile({
  tricks,
  side,
  positionOf,
  width,
  open,
  onToggle,
}: {
  /** Every trick of the board so far; only the finished ones go on the pile */
  tricks: Trick[]
  /** The viewer's side: its tricks stand upright */
  side: Side
  positionOf: (seat: Seat) => Position
  /** Card width at the table; the pile and the last-trick window scale from it */
  width: number
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const done = tricks.filter((trick): trick is Trick & { winner: Seat } => !!trick.winner)
  const won = done.filter((trick) => sideOf(trick.winner) === side).length
  const last = done.at(-1)
  const w = Math.max(14, Math.round(width * 0.3))
  const h = Math.round(w * CARD_RATIO)
  // Every card starts this far from the one before, whichever way each lies
  const step = Math.round(w * 0.42)
  const widthOf = (trick: Trick & { winner: Seat }) => (sideOf(trick.winner) === side ? w : h)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onToggle()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onToggle])

  return (
    <Wrap>
      {open && last && (
        <LastTrick key={done.length} trick={last} positionOf={positionOf} width={Math.max(30, Math.round(width * 0.5))} />
      )}
      <Pile
        type="button"
        $h={h}
        disabled={!last}
        onClick={onToggle}
        aria-expanded={open && !!last}
        aria-label={t.trickPile(won, done.length - won)}
        title={t.trickPile(won, done.length - won)}
      >
        {done.map((trick, i) => {
          const ours = sideOf(trick.winner) === side
          return (
            <Mini
              key={i}
              $w={ours ? w : h}
              $h={ours ? h : w}
              style={i ? { marginLeft: step - widthOf(done[i - 1]) } : undefined}
              data-ours={ours}
            />
          )
        })}
      </Pile>
    </Wrap>
  )
}
