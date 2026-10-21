import styled, { css } from 'styled-components'
import { rankLabel, rankOf, suitOf, SUIT_SYMBOL, type Card, type Suit } from '../../shared/cards.ts'
import { CARD_RATIO, cardName } from '../lib/cards.ts'
import { useT } from '../state/PreferencesContext.tsx'

/**
 * A card in BBO's style: white face, a large rank with its suit in the top-left corner (the part
 * that stays visible when cards overlap) and a big pip in the lower right. Sizes are in pixels so
 * the table can scale cards to the window. `corner="inline"` puts rank and suit side by side, for
 * hands fanned downwards.
 */

const Face = styled.button<{ $w: number; $playable: boolean; $dim: boolean; $highlight: boolean }>`
  position: relative;
  flex: none;
  width: ${({ $w }) => $w}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO)}px;
  padding: 0;
  border-radius: ${({ $w }) => Math.max(4, Math.round($w * 0.08))}px;
  border: 1px solid ${({ theme }) => theme.table.cardBorder};
  background: ${({ theme }) => theme.table.cardFace};
  box-shadow: ${({ theme }) => theme.cardShadow};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
  line-height: 1;
  transition: transform 0.12s ease;
  outline-offset: 1px;

  &:disabled { opacity: 1; }
  ${({ $playable, $w }) =>
    $playable &&
    css`
      cursor: pointer;
      &:hover, &:focus-visible { transform: translateY(-${Math.round($w * 0.18)}px); }
    `}
  ${({ $dim, theme }) =>
    $dim &&
    css`
      &::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        background: ${theme.table.cardDisabled};
      }
    `}
  ${({ $highlight, theme }) =>
    $highlight &&
    css`
      box-shadow: 0 0 0 3px ${theme.table.winner};
    `}
`

const Corner = styled.span<{ $w: number; $inline: boolean; $suit: Suit }>`
  position: absolute;
  top: ${({ $w }) => Math.round($w * 0.06)}px;
  left: ${({ $w }) => Math.round($w * 0.07)}px;
  display: flex;
  flex-direction: ${({ $inline }) => ($inline ? 'row' : 'column')};
  align-items: center;
  gap: ${({ $inline }) => ($inline ? '1px' : '0')};
  font-size: ${({ $w }) => Math.round($w * 0.34)}px;
  letter-spacing: -0.06em;
  color: ${({ theme, $suit }) => theme.cardSuits[$suit]};
`

const CornerSuit = styled.span<{ $w: number; $inline: boolean }>`
  font-family: ${({ theme }) => theme.fonts.symbols};
  font-size: ${({ $w, $inline }) => Math.round($w * ($inline ? 0.32 : 0.3))}px;
  line-height: 1.05;
`

const Pip = styled.span<{ $w: number; $suit: Suit }>`
  position: absolute;
  right: ${({ $w }) => Math.round($w * 0.08)}px;
  bottom: ${({ $w }) => Math.round($w * 0.06)}px;
  font-family: ${({ theme }) => theme.fonts.symbols};
  font-size: ${({ $w }) => Math.round($w * 0.56)}px;
  color: ${({ theme, $suit }) => theme.cardSuits[$suit]};
`

export function PlayingCard({
  card,
  width,
  playable = false,
  dim = false,
  highlight = false,
  corner = 'stack',
  onPlay,
}: {
  card: Card
  width: number
  playable?: boolean
  dim?: boolean
  highlight?: boolean
  corner?: 'stack' | 'inline'
  onPlay?: (card: Card) => void
}) {
  const t = useT()
  const suit = suitOf(card)
  const inline = corner === 'inline'
  return (
    <Face
      type="button"
      $w={width}
      $playable={playable}
      $dim={dim}
      $highlight={highlight}
      disabled={!playable}
      onClick={playable ? () => onPlay?.(card) : undefined}
      aria-label={cardName(card, t)}
      data-card={card}
    >
      <Corner $w={width} $inline={inline} $suit={suit} aria-hidden>
        <span>{rankLabel(rankOf(card))}</span>
        <CornerSuit $w={width} $inline={inline}>
          {SUIT_SYMBOL[suit]}
        </CornerSuit>
      </Corner>
      <Pip $w={width} $suit={suit} aria-hidden>
        {SUIT_SYMBOL[suit]}
      </Pip>
    </Face>
  )
}

const Back = styled.div<{ $w: number }>`
  flex: none;
  width: ${({ $w }) => $w}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO)}px;
  border-radius: ${({ $w }) => Math.max(4, Math.round($w * 0.08))}px;
  border: 3px solid ${({ theme }) => theme.table.cardFace};
  background: repeating-linear-gradient(
    45deg,
    ${({ theme }) => theme.table.cardBack} 0 6px,
    ${({ theme }) => theme.table.cardBackStripe} 6px 12px
  );
  box-shadow: ${({ theme }) => theme.cardShadow};
`

export function CardBack({ width }: { width: number }) {
  return <Back $w={width} aria-hidden />
}
