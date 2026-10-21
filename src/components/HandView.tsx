import styled, { css } from 'styled-components'
import { bySuit, rankLabel, rankOf, SUITS, suitOf, type Card } from '../../shared/cards.ts'
import { cardName, cardWidth, type CardSize } from '../lib/cards.ts'
import { CardBack, PlayingCard } from './PlayingCard.tsx'
import { SuitSymbol } from './Suit.tsx'

/**
 * One hand on the table. `fan` overlaps the cards as BBO does; `rows` lists each suit on a line
 * (BBO's text hand style), which fits the narrow side columns on a phone. A hand the viewer may
 * not see is drawn as card backs.
 */

export type HandLayout = 'fan' | 'rows'

/** How much of each overlapped card stays visible */
const OVERLAP: Record<CardSize, number> = { lg: 32, md: 22, sm: 16 }

const Fan = styled.div<{ $size: CardSize }>`
  display: flex;
  justify-content: center;
  min-height: ${({ $size }) => ($size === 'lg' ? 104 : $size === 'md' ? 84 : 64)}px;
  padding-top: 10px;

  & > * + * {
    margin-left: ${({ $size }) => OVERLAP[$size] - cardWidth($size)}px;
  }
  & > [data-suit-start] {
    margin-left: ${({ $size }) => OVERLAP[$size] - cardWidth($size) + 6}px;
  }
`

const Rows = styled.div`
  display: inline-grid;
  gap: 2px;
  min-width: 120px;
  padding: 6px 10px;
  border-radius: 6px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 600;
  font-size: 15px;
  line-height: 1.5;
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 2px;
  min-height: 22px;
`

const RankButton = styled.button<{ $playable: boolean }>`
  min-width: 20px;
  padding: 0 2px;
  border: 0;
  border-radius: 3px;
  background: none;
  font-weight: 700;
  ${({ $playable, theme }) =>
    $playable
      ? css`
          cursor: pointer;
          background: ${theme.table.turn};
        `
      : css`
          &:disabled { color: inherit; }
        `}
`

const Hidden = styled.div`
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: 14px;
`

export function HandView({
  cards,
  count,
  layout = 'fan',
  size = 'md',
  playable = [],
  onPlay,
  label,
}: {
  /** The cards, or undefined when the viewer may not see them */
  cards?: Card[]
  count: number
  layout?: HandLayout
  size?: CardSize
  playable?: Card[]
  onPlay?: (card: Card) => void
  label: string
}) {
  const canPlay = new Set(playable)
  const anyPlayable = canPlay.size > 0

  if (layout === 'rows') {
    if (!cards) return <Hidden aria-label={label}>{count ? `${count} 張` : ''}</Hidden>
    const groups = bySuit(cards)
    return (
      <Rows role="group" aria-label={label}>
        {SUITS.map((suit) => (
          <Row key={suit}>
            <SuitSymbol suit={suit} onCard />
            {groups[suit].length === 0 && <span aria-hidden>—</span>}
            {groups[suit].map((card) => (
              <RankButton
                key={card}
                type="button"
                $playable={canPlay.has(card)}
                disabled={!canPlay.has(card)}
                onClick={() => onPlay?.(card)}
                aria-label={cardName(card)}
              >
                {rankLabel(rankOf(card))}
              </RankButton>
            ))}
          </Row>
        ))}
      </Rows>
    )
  }

  if (!cards)
    return (
      <Fan $size={size} role="group" aria-label={label}>
        {Array.from({ length: count }, (_, i) => (
          <CardBack key={i} size={size} />
        ))}
      </Fan>
    )

  return (
    <Fan $size={size} role="group" aria-label={label}>
      {cards.map((card, i) => (
        <span key={card} data-suit-start={i > 0 && suitOf(cards[i - 1]) !== suitOf(card) ? '' : undefined}>
          <PlayingCard
            card={card}
            size={size}
            playable={canPlay.has(card)}
            dim={anyPlayable && !canPlay.has(card)}
            onPlay={onPlay}
          />
        </span>
      ))}
    </Fan>
  )
}
