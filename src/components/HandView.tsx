import styled, { css } from 'styled-components'
import { rankLabel, rankOf, SUITS, suitOf, type Card, type Suit } from '../../shared/cards.ts'
import { CARD_RATIO, cardName, sortForDisplay } from '../lib/cards.ts'
import { LIFT, ROW_STEP, type Orientation } from '../lib/measure.ts'
import { useT, type CardStyle } from '../state/PreferencesContext.tsx'
import { CardBack, PlayingCard } from './PlayingCard.tsx'
import { SuitSymbol } from './Suit.tsx'

/**
 * One hand on the table, drawn the same way for every hand (the viewer picks card faces or text):
 *
 * - cards, horizontal: overlapped like BBO, as wide as the space allows; each card keeps at most
 *   about 47% of its width visible and squeezes when the space is narrow
 * - cards, rows: BBO's dummy on the left or right, one overlapped row per suit, the rows stacked
 * - cards, vertical: fanned downwards, for the side hands on a phone
 * - text: one line per suit (♠ A K 10 5), BBO's text hand style
 *
 * Suits follow `order` (the table passes BBO's alternating colours with trumps first). A hand the
 * viewer may not see is card backs (or the number of cards in text style). Cards in `played` stay
 * in the hand greyed out, as BBO's Handviewer shows a board being replayed.
 */

export type { Orientation }

const Fan = styled.div<{ $w: number }>`
  display: flex;
  justify-content: center;
  min-width: 0;
  max-width: 100%;
  padding-top: ${({ $w }) => Math.round($w * LIFT)}px;
`

const Slot = styled.span<{ $w: number; $gap: boolean }>`
  flex: 0 1 ${({ $w }) => Math.round($w * 0.47)}px;
  min-width: 0;
  ${({ $gap, $w }) => $gap && `margin-left: ${Math.round($w * 0.1)}px;`}
  &:last-child { flex: none; width: ${({ $w }) => $w}px; }
`

const Rows = styled.div<{ $w: number }>`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  max-width: 100%;
  padding-top: ${({ $w }) => Math.round($w * LIFT)}px;
`

/** Each suit row shows just its top, enough for the rank and suit in the corner */
const SuitRow = styled.div<{ $w: number }>`
  display: flex;
  min-width: 0;
  max-width: 100%;
  height: ${({ $w }) => Math.round($w * ROW_STEP)}px;
  &:last-child { height: ${({ $w }) => Math.round($w * CARD_RATIO)}px; }
`

const Column = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
`

const Down = styled.span<{ $w: number; $gap: boolean }>`
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

/** One suit: the symbol, then the ranks packed together as BBO writes them (♥Q10763), on one line */
const TextRow = styled.div`
  display: flex;
  align-items: baseline;
  white-space: nowrap;

  & > :first-child { flex: none; width: 1.15em; }
`

const RankButton = styled.button<{ $playable: boolean; $played: boolean; $raised: boolean }>`
  min-width: 0;
  padding: 0 0.05em;
  border: 0;
  border-radius: 4px;
  background: none;
  font-family: inherit;
  font-weight: 700;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
  ${({ $playable, theme }) =>
    $playable &&
    css`
      cursor: pointer;
      background: ${theme.table.turn};
      &:hover { outline: 2px solid ${theme.table.panelText}; }
    `}
  &:disabled { color: inherit; }
  ${({ $played, theme }) =>
    $played &&
    css`
      &, &:disabled { color: ${theme.table.playedText}; }
    `}
  ${({ $raised, theme }) =>
    $raised &&
    css`
      outline: 3px solid ${theme.table.panelText};
      outline-offset: 1px;
    `}
`

/** A void: a dash on the same line and baseline as the ranks would be */
const Void = styled.span`
  padding: 0 0.05em;
  opacity: 0.55;
`

const Hidden = styled.div<{ $w: number }>`
  padding: 4px 10px;
  border-radius: 6px;
  background: ${({ theme }) => theme.table.shade};
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: ${({ $w }) => Math.max(14, Math.round($w * 0.24))}px;
`

export function HandView({
  cards,
  count,
  width,
  orientation = 'horizontal',
  style = 'cards',
  order = SUITS,
  playable = [],
  played = [],
  chosen = null,
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
  /** The order of the suits, left to right (top to bottom in text and rows) */
  order?: readonly Suit[]
  playable?: Card[]
  /** Cards already played that are still drawn, greyed out */
  played?: Card[]
  /** The card lifted out of the hand, waiting to be played */
  chosen?: Card | null
  onPlay?: (card: Card) => void
  label: string
}) {
  const t = useT()
  const canPlay = new Set(playable)
  const gone = new Set(played)
  const anyPlayable = canPlay.size > 0
  // A hand you play from can be played with the keyboard (useCardChoice); the tooltip says how
  const keys = anyPlayable && onPlay ? { title: t.playKeysHint, 'aria-keyshortcuts': 'ArrowLeft ArrowRight Enter' } : {}
  const sorted = cards && sortForDisplay(cards, order)
  const suitStart = (list: Card[], i: number) => i > 0 && suitOf(list[i - 1]) !== suitOf(list[i])
  const groups = (list: Card[]) => order.map((suit) => list.filter((card) => suitOf(card) === suit))

  if (style === 'text') {
    if (!sorted)
      return (
        <Hidden $w={width} role="group" aria-label={label}>
          {count ? t.cardsLeft(count) : ''}
        </Hidden>
      )
    return (
      <Text $w={width} role="group" aria-label={label} {...keys}>
        {groups(sorted).map((suitCards, i) => (
          <TextRow key={order[i]}>
            <SuitSymbol suit={order[i]} onCard />
            {suitCards.length === 0 && <Void aria-hidden>—</Void>}
            {suitCards.map((card) => (
              <RankButton
                key={card}
                type="button"
                $playable={canPlay.has(card)}
                $played={gone.has(card)}
                $raised={card === chosen}
                aria-current={card === chosen || undefined}
                disabled={!canPlay.has(card)}
                onClick={() => onPlay?.(card)}
                aria-label={gone.has(card) ? t.playedCard(cardName(card, t)) : cardName(card, t)}
              >
                {rankLabel(rankOf(card))}
              </RankButton>
            ))}
          </TextRow>
        ))}
      </Text>
    )
  }

  const list: (Card | null)[] = sorted ?? Array.from({ length: count }, () => null)
  const face = (card: Card | null, key: number) =>
    card ? (
      <PlayingCard
        card={card}
        width={width}
        playable={canPlay.has(card)}
        dim={anyPlayable && !canPlay.has(card)}
        played={gone.has(card)}
        raised={card === chosen}
        corner={orientation === 'vertical' ? 'inline' : 'stack'}
        onPlay={onPlay}
      />
    ) : (
      <CardBack key={key} width={width} />
    )

  if (orientation === 'rows' && sorted)
    return (
      <Rows $w={width} role="group" aria-label={label} {...keys}>
        {groups(sorted)
          .filter((suitCards) => suitCards.length)
          .map((suitCards) => (
            <SuitRow key={suitOf(suitCards[0])} $w={width}>
              {suitCards.map((card) => (
                <Slot key={card} $w={width} $gap={false}>
                  {face(card, 0)}
                </Slot>
              ))}
            </SuitRow>
          ))}
      </Rows>
    )

  if (orientation === 'vertical')
    return (
      <Column role="group" aria-label={label} {...keys}>
        {list.map((card, i) => (
          <Down key={card ?? i} $w={width} $gap={!!sorted && suitStart(sorted, i)}>
            {face(card, i)}
          </Down>
        ))}
      </Column>
    )

  return (
    <Fan $w={width} role="group" aria-label={label} {...keys}>
      {list.map((card, i) => (
        <Slot key={card ?? i} $w={width} $gap={!!sorted && suitStart(sorted, i)}>
          {face(card, i)}
        </Slot>
      ))}
    </Fan>
  )
}
