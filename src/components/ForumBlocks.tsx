import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { bookUrl } from '../../shared/book-site.ts'
import { RANKS, rankOf, SUITS, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import type { ForumDeal as ForumDealValue, ForumRuleItem, PostBlock } from '../../shared/forum.ts'
import { dealRecord } from '../../shared/forum-editor.ts'
import { CARD_SCALE } from '../lib/cards.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { mobileQuery } from '../styles/tokens.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { AuctionBox } from './AuctionBox.tsx'
import { RecordDiagram } from './RecordDiagram.tsx'
import { SuitSymbol, SuitText } from './Suit.tsx'

/**
 * A forum post's or comment's blocks (shared/forum.ts `PostBlock`, ARCHITECTURE.md §5.19), drawn
 * with the table's own pieces: the suits in the deck's colours (`SuitSymbol`) and the auction in
 * the record pages' `AuctionBox`. A post is never HTML, so nothing here sets inner HTML; text is
 * shown as text with its line breaks. Four hands are drawn with the record pages' `RecordDiagram` (K2).
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

const DealFrame = styled.div`
  max-width: 640px;
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

/**
 * Four hands drawn with the record pages' diagram (AC-13.2), sized as the record page sizes it:
 * the seats named instead of players, no board number, nothing played
 */
export function ForumDeal({ deal }: { deal: ForumDealValue }) {
  const { cardStyle, cardSize } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const scale = CARD_SCALE[cardSize]
  const side = (seat: Seat) => seat === 'E' || seat === 'W'
  return (
    <DealFrame>
      <RecordDiagram
        record={dealRecord(deal)}
        step={0}
        width={Math.round((phone ? 40 : 60) * scale)}
        trickWidth={Math.round((phone ? 24 : 40) * scale)}
        styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
        orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
        anonymous
      />
    </DealFrame>
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
          <ForumDeal deal={block.deal} />
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
