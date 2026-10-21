import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { PlayedCard } from '../../shared/game.ts'
import type { CardSize } from '../lib/cards.ts'
import { PlayingCard } from './PlayingCard.tsx'

/** The cards of one trick in the middle of the table, each in front of the seat that played it */

export type Position = 'top' | 'right' | 'bottom' | 'left'

const Area = styled.div<{ $size: CardSize }>`
  position: relative;
  width: ${({ $size }) => ($size === 'sm' ? 150 : 190)}px;
  height: ${({ $size }) => ($size === 'sm' ? 150 : 190)}px;
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
  size = 'md',
  label,
}: {
  cards: PlayedCard[]
  positionOf: (seat: Seat) => Position
  winner?: Seat
  size?: CardSize
  label: string
}) {
  return (
    <Area $size={size} role="group" aria-label={label}>
      {cards.map(({ seat, card }) => (
        <Slot key={seat} $position={positionOf(seat)}>
          <PlayingCard card={card} size={size} highlight={seat === winner} />
        </Slot>
      ))}
    </Area>
  )
}
