import styled, { css } from 'styled-components'
import { rankLabel, rankOf, suitOf, type Card, type Suit } from '../../shared/cards.ts'
import { CARD_SIZES, cardName, type CardSize } from '../lib/cards.ts'
import { SuitSymbol } from './Suit.tsx'

/**
 * A card in BBO's style: white face, rank and suit stacked in the top-left corner (the part that
 * stays visible when cards overlap) and a large pip in the middle.
 */

const SIZES = CARD_SIZES

const face = css<{ $size: CardSize }>`
  position: relative;
  flex: none;
  width: ${({ $size }) => SIZES[$size].w}px;
  height: ${({ $size }) => SIZES[$size].h}px;
  border-radius: 6px;
  border: 1px solid ${({ theme }) => theme.table.cardBorder};
  box-shadow: ${({ theme }) => theme.cardShadow};
`

const Face = styled.button<{ $size: CardSize; $playable: boolean; $dim: boolean; $highlight: boolean }>`
  ${face}
  padding: 0;
  background: ${({ theme }) => theme.table.cardFace};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
  font-size: ${({ $size }) => SIZES[$size].font}px;
  line-height: 1;
  transition: transform 0.12s ease;
  outline-offset: 1px;

  &:disabled { opacity: 1; }
  ${({ $playable }) =>
    $playable &&
    css`
      cursor: pointer;
      &:hover, &:focus-visible { transform: translateY(-10px); }
    `}
  ${({ $dim, theme }) =>
    $dim &&
    css`
      &::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 5px;
        background: ${theme.table.cardDisabled};
      }
    `}
  ${({ $highlight, theme }) =>
    $highlight &&
    css`
      box-shadow: 0 0 0 3px ${theme.table.winner};
    `}
`

const Corner = styled.span`
  position: absolute;
  top: 4px;
  left: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  letter-spacing: -1px;
`

const RankText = styled.span<{ $suit: Suit }>`
  color: ${({ theme, $suit }) => theme.cardSuits[$suit]};
`

const Pip = styled.span<{ $size: CardSize }>`
  position: absolute;
  right: 6px;
  bottom: 4px;
  font-size: ${({ $size }) => SIZES[$size].font * 1.5}px;
`

export function PlayingCard({
  card,
  size = 'md',
  playable = false,
  dim = false,
  highlight = false,
  onPlay,
}: {
  card: Card
  size?: CardSize
  playable?: boolean
  dim?: boolean
  highlight?: boolean
  onPlay?: (card: Card) => void
}) {
  const suit = suitOf(card)
  const rank = rankLabel(rankOf(card))
  return (
    <Face
      type="button"
      $size={size}
      $playable={playable}
      $dim={dim}
      $highlight={highlight}
      disabled={!playable}
      onClick={playable ? () => onPlay?.(card) : undefined}
      aria-label={cardName(card)}
      data-card={card}
    >
      <Corner aria-hidden>
        <RankText $suit={suit}>{rank}</RankText>
        <SuitSymbol suit={suit} onCard />
      </Corner>
      <Pip $size={size} aria-hidden>
        <SuitSymbol suit={suit} onCard />
      </Pip>
    </Face>
  )
}


const Back = styled.div<{ $size: CardSize }>`
  ${face}
  background: repeating-linear-gradient(
    45deg,
    ${({ theme }) => theme.table.cardBack} 0 6px,
    ${({ theme }) => theme.table.cardBackStripe} 6px 12px
  );
  border: 3px solid ${({ theme }) => theme.table.cardFace};
`

export function CardBack({ size = 'md' }: { size?: CardSize }) {
  return <Back $size={size} aria-hidden />
}
