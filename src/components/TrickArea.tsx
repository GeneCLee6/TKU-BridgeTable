import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { PlayedCard } from '../../shared/game.ts'
import { CARD_RATIO } from '../lib/cards.ts'
import { PlayingCard } from './PlayingCard.tsx'

/** The cards of one trick in the middle of the table, each in front of the seat that played it */

export type Position = 'top' | 'right' | 'bottom' | 'left'

const Area = styled.div<{ $w: number }>`
  position: relative;
  width: ${({ $w }) => Math.round($w * 3.1)}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO * 2.3)}px;
  margin: 0 auto;
`

const Slot = styled.div<{ $position: Position }>`
  position: absolute;
  ${({ $position }) =>
    ({
      top: 'top: 0; left: 50%; transform: translateX(-50%);',
      bottom: 'bottom: 0; left: 50%; transform: translateX(-50%);',
      left: 'left: 0; top: 50%; transform: translateY(-50%);',
      right: 'right: 0; top: 50%; transform: translateY(-50%);',
    })[$position]}
`

export function TrickArea({
  cards,
  positionOf,
  winner,
  width,
  label,
}: {
  cards: PlayedCard[]
  positionOf: (seat: Seat) => Position
  winner?: Seat
  width: number
  label: string
}) {
  return (
    <Area $w={width} role="group" aria-label={label}>
      {cards.map(({ seat, card }) => (
        <Slot key={seat} $position={positionOf(seat)}>
          <PlayingCard card={card} width={width} highlight={seat === winner} />
        </Slot>
      ))}
    </Area>
  )
}

/** The empty space a trick will take, so the table does not jump when the first card is played */
export const TrickSpace = styled.div<{ $w: number }>`
  width: ${({ $w }) => Math.round($w * 3.1)}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO * 2.3)}px;
`
