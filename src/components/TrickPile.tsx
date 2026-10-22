import { useEffect } from 'react'
import styled from 'styled-components'
import { sideOf, type Seat, type Side } from '../../shared/cards.ts'
import type { Trick } from '../../shared/game.ts'
import { CARD_RATIO } from '../lib/cards.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { TrickArea, type Position } from './TrickArea.tsx'

/**
 * The finished tricks, face down in the corner as on BBO: upright for a trick your side won,
 * sideways for one it lost. Clicking the pile opens the last trick in a small window just above
 * it, away from the trick being played in the middle; clicking again (or Escape) closes it.
 */

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

const Mini = styled.span<{ $w: number; $h: number; $overlap: number }>`
  flex: 0 1 auto;
  min-width: 6px;
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
  & + & { margin-left: -${({ $overlap }) => $overlap}px; }
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

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onToggle()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onToggle])

  return (
    <Wrap>
      {open && last && (
        <Popup role="dialog" aria-label={t.lastTrick}>
          <span>{t.lastTrick}</span>
          <TrickArea
            cards={last.cards}
            positionOf={positionOf}
            winner={last.winner}
            width={Math.max(30, Math.round(width * 0.5))}
            label={t.lastTrick}
          />
        </Popup>
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
          return <Mini key={i} $w={ours ? w : h} $h={ours ? h : w} $overlap={Math.round(w * 0.4)} data-ours={ours} />
        })}
      </Pile>
    </Wrap>
  )
}
