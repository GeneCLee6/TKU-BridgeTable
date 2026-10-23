import styled, { css } from 'styled-components'
import { hcp, SEATS, suitOf, type Seat, type Suit } from '../../shared/cards.ts'
import { remainingCards, tricksOf } from '../../shared/game.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import { suitOrder } from '../lib/cards.ts'
import type { Orientation } from '../lib/measure.ts'
import { usePreferences, type CardStyle } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { BoardInfo } from './BoardInfo.tsx'
import { HandView } from './HandView.tsx'
import { TrickArea, TrickSpace, type Position } from './TrickArea.tsx'

/**
 * A finished board drawn as BBO's Handviewer does: North at the top, the board marker tucked into
 * the top-left corner so the hands get the room, the suits in ♠ ♥ ♣ ♦ order so the colours
 * alternate, and the trick being replayed in the middle. The cards played so far stay in their
 * hands greyed out, or leave them, as the viewer chooses (`playedCards`, PlayedCardsSwitch).
 */

const POSITIONS: Record<Position, Seat> = { top: 'N', right: 'E', bottom: 'S', left: 'W' }
const positionOf = (seat: Seat) => (Object.keys(POSITIONS) as Position[]).find((p) => POSITIONS[p] === seat)!

/** A hand record's suit order: black and red alternate */
const RECORD_SUITS: readonly Suit[] = ['S', 'H', 'C', 'D']

const Diagram = styled.div<{ $compact: boolean }>`
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  grid-template-areas:
    'top top top'
    'left center right'
    'bottom bottom bottom';
  align-items: center;
  justify-items: center;
  gap: ${({ $compact }) => ($compact ? '6px 4px' : '10px')};
  padding: ${({ $compact }) => ($compact ? '8px 4px' : '16px')};
  border-radius: ${({ theme, $compact }) => ($compact ? theme.radius.md : theme.radius.lg)};
  background: radial-gradient(ellipse at center, ${({ theme }) => theme.table.felt} 55%, ${({ theme }) => theme.table.feltEdge});
  color: ${({ theme }) => theme.table.feltText};
`

/** The board marker, out of the way in the corner */
const Corner = styled.div<{ $compact: boolean }>`
  position: absolute;
  top: ${({ $compact }) => ($compact ? 6 : 10)}px;
  left: ${({ $compact }) => ($compact ? 6 : 10)}px;
`

const Spot = styled.div<{ $area: string }>`
  grid-area: ${({ $area }) => $area};
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
`

const Name = styled.div<{ $compact: boolean }>`
  font-size: ${({ $compact }) => ($compact ? 13 : 15)}px;
  font-weight: 700;
  ${({ $compact }) =>
    $compact &&
    css`
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `}
`

export function RecordDiagram({
  record,
  step,
  width,
  trickWidth,
  styleFor,
  orientationFor,
  compact = false,
}: {
  record: BoardRecord
  /** Cards of the replay shown so far */
  step: number
  /** Card width of the hands (text hands scale their font from it) */
  width: number
  trickWidth: number
  styleFor: (seat: Seat) => CardStyle
  orientationFor?: (seat: Seat) => Orientation
  /** The side panel's smaller version: names only, tighter spacing */
  compact?: boolean
}) {
  const { t, playedCards } = usePreferences()
  const { board, players } = record
  const shown = { ...board, play: board.play.slice(0, step) }
  const current = tricksOf(shown).at(-1)
  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)

  return (
    <Diagram $compact={compact}>
      <Corner $compact={compact}>
        <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={POSITIONS} size={compact ? 14 : 18} />
      </Corner>
      {SEATS.map((seat) => {
        const style = styleFor(seat)
        const dealt = board.hands[seat]
        const played = shown.play.filter((p) => p.seat === seat).map((p) => p.card)
        const grey = playedCards === 'grey'
        const held = [...new Set(dealt.map(suitOf))] as Suit[]
        return (
          <Spot key={seat} $area={positionOf(seat)}>
            <Name $compact={compact}>
              {seatLetter[seat]} {name(players[seat])}
              {!compact && ` · ${t.hcp(hcp(dealt))}`}
            </Name>
            <HandView
              cards={grey ? dealt : remainingCards(shown, seat)}
              played={grey ? played : []}
              count={13}
              width={width}
              style={style}
              orientation={orientationFor?.(seat)}
              order={style === 'text' ? RECORD_SUITS : suitOrder(null, held)}
              label={`${seatLetter[seat]} ${name(players[seat])}`}
            />
          </Spot>
        )
      })}
      <Spot $area="center">
        {current && step > 0 ? (
          <TrickArea cards={current.cards} positionOf={positionOf} winner={current.winner} width={trickWidth} label={t.thisTrick} />
        ) : (
          <TrickSpace $w={trickWidth} />
        )}
      </Spot>
    </Diagram>
  )
}

const Switch = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;

  & > button {
    position: relative;
    flex: none;
    width: 40px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: 11px;
    background: ${({ theme }) => theme.colors.border};
    transition: background 0.15s ease;
  }
  & > button::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: ${({ theme }) => theme.colors.surface};
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s ease;
  }
  & > button[aria-checked='true'] { background: ${({ theme }) => theme.colors.primary}; }
  & > button[aria-checked='true']::after { transform: translateX(18px); }
`

/** On: cards already played stay in the hands, greyed out (BBO's Handviewer); off: they leave */
export function PlayedCardsSwitch() {
  const { t, playedCards, set } = usePreferences()
  const on = playedCards === 'grey'
  return (
    <Switch>
      <button type="button" role="switch" aria-checked={on} onClick={() => set({ playedCards: on ? 'hide' : 'grey' })} />
      {t.playedCardsGrey}
    </Switch>
  )
}
