import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { bookUrl } from '../../shared/book-site.ts'
import { RANKS, rankOf, SEATS, SUITS, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import type { ForumDeal, ForumRuleItem, PostBlock } from '../../shared/forum.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { AuctionBox } from './AuctionBox.tsx'
import { SuitSymbol, SuitText } from './Suit.tsx'

/**
 * A forum post's or comment's blocks (shared/forum.ts `PostBlock`, ARCHITECTURE.md §5.19), drawn
 * with the table's own pieces: the suits in the deck's colours (`SuitSymbol`) and the auction in
 * the record pages' `AuctionBox`. A post is never HTML, so nothing here sets inner HTML; text is
 * shown as text with its line breaks. The four-hand editor and `RecordDiagram` come with K2.
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  min-width: 0;
`

const Paragraph = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

const Note = styled.p<{ $warning: boolean }>`
  margin: 0;
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  border-left: 4px solid ${({ theme, $warning }) => ($warning ? theme.colors.danger : theme.colors.accent)};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $warning }) => ($warning ? theme.colors.dangerSoft : theme.colors.accentSoft)};
  color: ${({ theme }) => theme.colors.text};
  white-space: pre-wrap;
`

const List = styled.ul`
  margin: 0;
  padding-left: 1.4em;
  line-height: 1.7;
`

const HandLine = styled.div`
  display: grid;
  gap: 2px;
  font-variant-numeric: tabular-nums;
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

const DealGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, max-content));
  grid-template-areas:
    '. N .'
    'W C E'
    '. S .';
  gap: ${({ theme }) => theme.space(3)};
  align-items: center;
  width: fit-content;
  max-width: 100%;
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

const DealSeat = styled.div<{ $seat: Seat }>`
  grid-area: ${({ $seat }) => $seat};
`

const DealCentre = styled.small`
  grid-area: C;
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: center;
`

const Caption = styled.small`
  color: ${({ theme }) => theme.colors.textMuted};
`

const Figure = styled.figure`
  display: grid;
  gap: 4px;
  margin: 0;
  & > img {
    max-width: 100%;
    height: auto;
    border-radius: ${({ theme }) => theme.radius.sm};
  }
`

const Ref = styled.a`
  color: ${({ theme }) => theme.colors.primary};
`

const rankText = (card: Card) => (rankOf(card) === 'T' ? '10' : rankOf(card))

/** One hand as four lines, spades first, high to low (cards are 'SA', 'HT', …) */
function Hand({ cards, label }: { cards: readonly Card[]; label?: string }) {
  return (
    <HandLine>
      {label && <small>{label}</small>}
      {SUITS.map((suit) => {
        const ranks = cards
          .filter((c) => suitOf(c) === suit)
          .sort((a, b) => RANKS.indexOf(rankOf(a)) - RANKS.indexOf(rankOf(b)))
          .map(rankText)
        return (
          <span key={suit}>
            <SuitSymbol suit={suit} /> {ranks.length ? ranks.join(' ') : '—'}
          </span>
        )
      })}
    </HandLine>
  )
}

function Deal({ deal }: { deal: ForumDeal }) {
  const { t } = usePreferences()
  return (
    <DealGrid>
      {SEATS.map((seat: Seat) => (
        <DealSeat key={seat} $seat={seat}>
          <Hand cards={deal.hands[seat]} label={t.seatNames[seat]} />
        </DealSeat>
      ))}
      <DealCentre>{t.dealerVul(t.seatNames[deal.dealer], t.vulNames[deal.vul])}</DealCentre>
    </DealGrid>
  )
}

function Rules({ items, ordered }: { items: ForumRuleItem[]; ordered?: boolean }) {
  return (
    <List as={ordered ? 'ol' : 'ul'}>
      {items.map((item, i) => (
        <li key={i}>
          <SuitText text={item.text} />
          {item.children?.length ? <Rules items={item.children} ordered={ordered} /> : null}
        </li>
      ))}
    </List>
  )
}

function Block({ block }: { block: PostBlock }) {
  const { t } = usePreferences()
  switch (block.kind) {
    case 'paragraph':
      return (
        <Paragraph>
          <SuitText text={block.text} />
        </Paragraph>
      )
    case 'note':
      return (
        <Note $warning={block.tone === 'warning'}>
          <SuitText text={block.text} />
        </Note>
      )
    case 'rules':
      return <Rules items={block.items} ordered={block.ordered} />
    case 'hand':
      return <Hand cards={block.cards} label={block.label} />
    case 'deal':
      return (
        <Figure>
          <Deal deal={block.deal} />
          {block.caption && <Caption>{block.caption}</Caption>}
        </Figure>
      )
    case 'auction':
      return (
        <Figure>
          <AuctionBox auction={block.auction.calls} dealer={block.auction.dealer} vul="None" size={40} />
          {block.caption && <Caption>{block.caption}</Caption>}
        </Figure>
      )
    case 'image':
      return (
        <Figure>
          <img src={`/api/files/${block.assetId}`} alt={block.alt || t.forum.image} loading="lazy" />
          {block.caption && <Caption>{block.caption}</Caption>}
        </Figure>
      )
    case 'ref':
      return (
        <Ref href={bookUrl(block.slug, block.sectionId)} target="_blank" rel="noreferrer">
          {t.forum.ref}
        </Ref>
      )
    case 'record':
      return <Link to={`/history/${encodeURIComponent(block.tableRecordId)}`}>{t.forum.record}</Link>
  }
}

export function ForumBlocks({ blocks }: { blocks: readonly PostBlock[] }) {
  return (
    <Stack>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </Stack>
  )
}
