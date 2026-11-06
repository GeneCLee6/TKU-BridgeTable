import { rankLabel, rankOf, SUITS, suitOf, type Card } from '../../shared/cards.ts'
import { SuitSymbol } from './Suit.tsx'

/** Cards as text, one suit after another: ♠ A K ♥ Q */
export function CardList({ cards }: { cards: readonly Card[] }) {
  return (
    <span>
      {SUITS.filter((suit) => cards.some((card) => suitOf(card) === suit)).map((suit) => (
        <span key={suit}>
          <SuitSymbol suit={suit} />{' '}
          {cards
            .filter((card) => suitOf(card) === suit)
            .map((card) => rankLabel(rankOf(card)))
            .join(' ')}{' '}
        </span>
      ))}
    </span>
  )
}
