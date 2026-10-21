import styled, { css } from 'styled-components'
import { bySuit, rankLabel, rankOf, SUITS, suitOf, type Card } from '../../shared/cards.ts'
import { CARD_RATIO, cardName } from '../lib/cards.ts'
import { useT, type CardStyle } from '../state/PreferencesContext.tsx'
import { CardBack, PlayingCard } from './PlayingCard.tsx'
import { SuitSymbol } from './Suit.tsx'

/**
 * One hand on the table, drawn the same way for every hand (the viewer picks card faces or text):
 *
 * - cards, horizontal: overlapped like BBO, as wide as the space allows; each card keeps at most
 *   about 40% of its width visible and squeezes when the space is narrow
 * - cards, vertical: fanned downwards, for the side hands on a phone
 * - text: one line per suit (♠ A K 10 5), BBO's text hand style
 *
 * A hand the viewer may not see is card backs (or the number of cards in text style).
 */

/**
 * - horizontal: one overlapped row (your hand, partner, a hidden hand)
 * - vertical: one column fanned downwards (side hands on a phone)
 * - suits: BBO's dummy layout, one column per suit with the cards stacked downwards; narrow, so
 *   it suits the left and right seats
 */
export type Orientation = 'horizontal' | 'vertical' | 'suits'

const Fan = styled.div<{ $w: number }>`
  display: flex;
  justify-content: center;
  width: 100%;
  min-width: 0;
  padding-top: ${({ $w }) => Math.round($w * 0.2)}px;
`

const Slot = styled.span<{ $w: number; $gap: boolean }>`
  flex: 0 1 ${({ $w }) => Math.round($w * 0.47)}px;
  min-width: 0;
  ${({ $gap, $w }) => $gap && `margin-left: ${Math.round($w * 0.1)}px;`}
  &:last-child { flex: none; width: ${({ $w }) => $w}px; }
`

const SuitColumns = styled.div<{ $w: number }>`
  display: flex;
  justify-content: center;
  gap: ${({ $w }) => Math.round($w * 0.1)}px;
`

const Column = styled.div<{ $w: number }>`
  display: flex;
  flex-direction: column;
  align-items: center;
`

const Row = styled.span<{ $w: number; $gap: boolean }>`
  display: block;
  height: ${({ $w }) => Math.round($w * 0.4)}px;
  ${({ $gap, $w }) => $gap && `margin-top: ${Math.round($w * 0.08)}px;`}
  &:last-child { height: ${({ $w }) => Math.round($w * CARD_RATIO)}px; }
`

const Text = styled.div<{ $w: number }>`
  display: inline-grid;
  gap: 2px;
  min-width: ${({ $w }) => Math.round($w * 2.6)}px;
  padding: ${({ $w }) => `${Math.round($w * 0.1)}px ${Math.round($w * 0.18)}px`};
  border-radius: 8px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
  font-size: ${({ $w }) => Math.max(14, Math.round($w * 0.32))}px;
  line-height: 1.35;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
`

const TextRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.2em;
`

const RankButton = styled.button<{ $playable: boolean }>`
  min-width: 1.2em;
  padding: 0 0.12em;
  border: 0;
  border-radius: 4px;
  background: none;
  font-weight: 700;
  font-size: inherit;
  color: inherit;
  ${({ $playable, theme }) =>
    $playable &&
    css`
      cursor: pointer;
      background: ${theme.table.turn};
      &:hover { outline: 2px solid ${theme.table.panelText}; }
    `}
  &:disabled { color: inherit; }
`

const Hidden = styled.div<{ $w: number }>`
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.18);
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: ${({ $w }) => Math.max(14, Math.round($w * 0.24))}px;
`

export function HandView({
  cards,
  count,
  width,
  orientation = 'horizontal',
  style = 'cards',
  playable = [],
  onPlay,
  label,
}: {
  /** The cards, or undefined when the viewer may not see them */
  cards?: Card[]
  count: number
  /** Card width in pixels; text style scales its font from it */
  width: number
  orientation?: Orientation
  style?: CardStyle
  playable?: Card[]
  onPlay?: (card: Card) => void
  label: string
}) {
  const t = useT()
  const canPlay = new Set(playable)
  const anyPlayable = canPlay.size > 0
  const suitStart = (list: Card[], i: number) => i > 0 && suitOf(list[i - 1]) !== suitOf(list[i])

  if (style === 'text') {
    if (!cards)
      return (
        <Hidden $w={width} role="group" aria-label={label}>
          {count ? t.cardsLeft(count) : ''}
        </Hidden>
      )
    const groups = bySuit(cards)
    return (
      <Text $w={width} role="group" aria-label={label}>
        {SUITS.map((suit) => (
          <TextRow key={suit}>
            <SuitSymbol suit={suit} onCard />
            {groups[suit].length === 0 && <span aria-hidden>—</span>}
            {groups[suit].map((card) => (
              <RankButton
                key={card}
                type="button"
                $playable={canPlay.has(card)}
                disabled={!canPlay.has(card)}
                onClick={() => onPlay?.(card)}
                aria-label={cardName(card, t)}
              >
                {rankLabel(rankOf(card))}
              </RankButton>
            ))}
          </TextRow>
        ))}
      </Text>
    )
  }

  const list: (Card | null)[] = cards ?? Array.from({ length: count }, () => null)
  const face = (card: Card | null, key: number) =>
    card ? (
      <PlayingCard
        card={card}
        width={width}
        playable={canPlay.has(card)}
        dim={anyPlayable && !canPlay.has(card)}
        corner={orientation === 'horizontal' ? 'stack' : 'inline'}
        onPlay={onPlay}
      />
    ) : (
      <CardBack key={key} width={width} />
    )

  if (orientation === 'suits' && cards) {
    const groups = bySuit(cards)
    return (
      <SuitColumns $w={width} role="group" aria-label={label}>
        {SUITS.filter((suit) => groups[suit].length).map((suit) => (
          <Column key={suit} $w={width}>
            {groups[suit].map((card) => (
              <Row key={card} $w={width} $gap={false}>
                {face(card, 0)}
              </Row>
            ))}
          </Column>
        ))}
      </SuitColumns>
    )
  }

  if (orientation === 'vertical')
    return (
      <Column $w={width} role="group" aria-label={label}>
        {list.map((card, i) => (
          <Row key={card ?? i} $w={width} $gap={!!cards && suitStart(cards, i)}>
            {face(card, i)}
          </Row>
        ))}
      </Column>
    )

  return (
    <Fan $w={width} role="group" aria-label={label}>
      {list.map((card, i) => (
        <Slot key={card ?? i} $w={width} $gap={!!cards && suitStart(cards, i)}>
          {face(card, i)}
        </Slot>
      ))}
    </Fan>
  )
}
