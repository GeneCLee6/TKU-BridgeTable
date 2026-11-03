import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { bookUrl } from '../../shared/book-site.ts'
import { RANKS, rankOf, SUITS, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import type { ForumDeal as ForumDealValue, ForumRuleItem, PostBlock } from '../../shared/forum.ts'
import { dealRecord } from '../../shared/forum-editor.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { fileUrls } from '../lib/postImage.ts'
import { CARD_SCALE } from '../lib/cards.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { mobileQuery } from '../styles/tokens.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { AuctionBox } from './AuctionBox.tsx'
import { RecordDiagram } from './RecordDiagram.tsx'
import { ContractResult, SuitSymbol, SuitText } from './Suit.tsx'

/**
 * A forum post's or comment's blocks (shared/forum.ts `PostBlock`, ARCHITECTURE.md §5.19), drawn
 * with the table's own pieces: the suits in the deck's colours (`SuitSymbol`) and the auction in
 * the record pages' `AuctionBox`. A post is never HTML, so nothing here sets inner HTML; text is
 * shown as text with its line breaks. Four hands are drawn with the record pages' `RecordDiagram` (K2).
 * A board shared from the history (`record`, e13-t07) is fetched from the record page's own API, so
 * the viewer sees it only as §4 lets them; the post keeps nothing but its id.
 * Pictures (e13-t13) are kept by key; their signed, short-lived addresses are fetched with each read
 * (`POST /api/files/urls`), and one the reader may no longer see (deleted, or on a hidden post)
 * shows as a note instead.
 */

/** Signed addresses of a post's pictures, by key */
type PostFiles = Record<string, { url: string; thumbUrl?: string }>

/** The pictures' addresses for these blocks; none while loading, when uploads are off or the call fails */
function usePostFiles(blocks: readonly PostBlock[]): { files: PostFiles; loaded: boolean } {
  const keyList = blocks.flatMap((b) => (b.kind === 'image' ? [b.assetId] : [])).join(' ')
  const [state, setState] = useState<{ keys: string; files: PostFiles }>({ keys: '', files: {} })
  useEffect(() => {
    if (!keyList) return
    let current = true
    fileUrls(keyList.split(' ')).then(
      (files) => current && setState({ keys: keyList, files }),
      () => current && setState({ keys: keyList, files: {} }),
    )
    return () => {
      current = false
    }
  }, [keyList])
  return state.keys === keyList ? { files: state.files, loaded: true } : { files: {}, loaded: !keyList }
}

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
  & > a {
    justify-self: start;
    max-width: 100%;
  }
  & img {
    display: block;
    max-width: 100%;
    max-height: 640px;
    height: auto;
    border-radius: ${({ theme }) => theme.radius.sm};
  }
`

const Missing = styled.p`
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  border: 1px dashed ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
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

const RecordLine = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)} ${({ theme }) => theme.space(4)};
  align-items: center;
`

/**
 * A board shared from the history (AC-13.3): its diagram with the players, the contract and result,
 * and a link to replay it on the record page. Read through `GET /api/history/:id`, which applies
 * the record page's visibility (§4); a board the viewer may not see, or one that is gone, is only
 * the link, which says the same as the record page would
 */
export function ForumRecord({ id }: { id: string }) {
  const { t, cardStyle, cardSize } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const [loaded, setLoaded] = useState<{ id: string; record: BoardRecord | null } | null>(null)
  useEffect(() => {
    let live = true
    api
      .record(id)
      .then((r) => live && setLoaded({ id, record: r.record }))
      .catch(() => live && setLoaded({ id, record: null }))
    return () => {
      live = false
    }
  }, [id])
  const record = loaded?.id === id ? loaded.record : null
  const link = `/history/${encodeURIComponent(id)}`
  if (!record) return <Link to={link}>{t.forum.record}</Link>
  const scale = CARD_SCALE[cardSize]
  const side = (seat: Seat) => seat === 'E' || seat === 'W'
  const { contract, result } = record.board
  return (
    <Figure>
      <DealFrame>
        <RecordDiagram
          record={record}
          step={0}
          width={Math.round((phone ? 40 : 60) * scale)}
          trickWidth={Math.round((phone ? 24 : 40) * scale)}
          styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
          orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
        />
      </DealFrame>
      <RecordLine>
        {result && <ContractResult contract={contract} tricks={result.declarerTricks} />}
        <Link to={link}>{t.forum.replay}</Link>
      </RecordLine>
    </Figure>
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

function Block({ block, files, loaded }: { block: PostBlock; files: PostFiles; loaded: boolean }) {
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
    case 'image': {
      const file = files[block.assetId]
      return (
        <Figure>
          {file ? (
            <a href={file.url} target="_blank" rel="noreferrer" title={t.forum.imageOpen}>
              <img src={file.url} alt={block.alt || t.forum.image} loading="lazy" />
            </a>
          ) : (
            loaded && <Missing>{t.forum.imageMissing}</Missing>
          )}
          {block.caption && <Caption>{block.caption}</Caption>}
        </Figure>
      )
    }
    case 'ref':
      return (
        <Ref href={bookUrl(block.slug, block.sectionId)} target="_blank" rel="noreferrer">
          {t.forum.ref}
        </Ref>
      )
    case 'record':
      return <ForumRecord id={block.tableRecordId} />
  }
}

export function ForumBlocks({ blocks }: { blocks: readonly PostBlock[] }) {
  const { files, loaded } = usePostFiles(blocks)
  return (
    <Stack>
      {blocks.map((block, i) => (
        <Block key={i} block={block} files={files} loaded={loaded} />
      ))}
    </Stack>
  )
}
