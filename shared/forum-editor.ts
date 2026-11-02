import { contractOf, isAuctionComplete, legalCalls, seatToCall, type Call, type Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import { fullDeck, nextSeat, SEATS, sortHand, type Card, type Hands, type Seat } from './cards.ts'
import { FORUM_LIMITS, type ForumAuction, type ForumAuctionCall, type ForumDeal, type ForumRuleItem, type PostBlock } from './forum.ts'
import type { BoardRecord, PublicUser } from './protocol.ts'

/**
 * The table's post editor (E13 K2: `e13-t04` 發文編輯器, `e13-t05` 四手牌編輯器, `e13-t06` 叫牌過程輸入,
 * ARCHITECTURE.md §5.19), as pure functions: what the editor sends is the forum's own blocks
 * (`shared/forum.ts`), the same format BridgeHall writes, so a post written on either site shows on
 * both. The Worker checks every post again (`worker/forum.ts`); these only catch what a member can
 * fix before sending, by the same rules.
 *
 * - Four hands: each card in at most one hand, at most 13 in a hand, at least one card in all. A
 *   deal may be partial (two hands, an ending): `dealStatus` says how many cards are left.
 * - An auction: only legal calls (`shared/auction.ts` `legalCalls`), at least one; it may stop
 *   before the end (a bidding problem).
 * - Text is a Markdown subset (`parseMarkdown`), turned into the forum's text blocks.
 */

// ── Four hands (e13-t05) ─────────────────────────────────────────────────────────────────────

export const HAND_SIZE = 13

/** A caption under a deal or an auction, as `worker/forum.ts` allows (BLOCK_LIMITS.captionMax) */
export const CAPTION_MAX = 200

export const VULNERABILITIES: readonly Vulnerability[] = ['None', 'NS', 'EW', 'Both']

export const emptyHands = (): Hands => ({ N: [], E: [], S: [], W: [] })

export const emptyDeal = (dealer: Seat = 'N', vul: Vulnerability = 'None'): ForumDeal => ({ hands: emptyHands(), dealer, vul })

/** The seat holding a card, if any */
export function ownerOf(hands: Hands, card: Card): Seat | undefined {
  return SEATS.find((seat) => hands[seat].includes(card))
}

/** The cards no hand holds yet, spades first and high to low */
export const unassignedCards = (hands: Hands): Card[] => sortHand(fullDeck().filter((card) => !ownerOf(hands, card)))

/**
 * A click on a card while `seat` is chosen: a card the seat holds goes back; a free card, or one
 * another seat holds, goes to the seat, unless it already has 13 (then nothing changes)
 */
export function toggleCard(hands: Hands, seat: Seat, card: Card): Hands {
  const owner = ownerOf(hands, card)
  if (owner === seat) return { ...hands, [seat]: hands[seat].filter((c) => c !== card) }
  if (hands[seat].length >= HAND_SIZE) return hands
  const next = { ...hands, [seat]: sortHand([...hands[seat], card]) }
  if (owner) next[owner] = hands[owner].filter((c) => c !== card)
  return next
}

/** The next seat clockwise from `from` (itself first) that is not full; `from` when all are */
export function seatToFill(hands: Hands, from: Seat): Seat {
  for (let i = 0; i < 4; i++) {
    const seat = nextSeat(from, i)
    if (hands[seat].length < HAND_SIZE) return seat
  }
  return from
}

/** The one seat still short when the other three have 13: the rest of the pack is its */
export function lastSeatToFill(hands: Hands): Seat | undefined {
  const short = SEATS.filter((seat) => hands[seat].length < HAND_SIZE)
  return short.length === 1 ? short[0] : undefined
}

/** Gives the cards left to the one seat still short (`lastSeatToFill`) */
export function fillRemaining(hands: Hands): Hands {
  const seat = lastSeatToFill(hands)
  return seat ? { ...hands, [seat]: sortHand([...hands[seat], ...unassignedCards(hands)]) } : hands
}

export type DealProblem = { kind: 'empty' } | { kind: 'duplicate'; card: Card } | { kind: 'tooMany'; seat: Seat }

/** What the Worker would refuse in four hands: a card twice, a hand over 13, no cards at all */
export function dealProblems(deal: ForumDeal): DealProblem[] {
  const problems: DealProblem[] = []
  const seen = new Set<Card>()
  for (const seat of SEATS) {
    if (deal.hands[seat].length > HAND_SIZE) problems.push({ kind: 'tooMany', seat })
    for (const card of deal.hands[seat]) {
      if (seen.has(card)) problems.push({ kind: 'duplicate', card })
      seen.add(card)
    }
  }
  if (seen.size === 0) problems.push({ kind: 'empty' })
  return problems
}

/** A whole deal (52 cards, 13 a hand) or a partial one, and how many cards no hand holds */
export function dealStatus(deal: ForumDeal): { complete: boolean; missing: number } {
  const missing = unassignedCards(deal.hands).length
  return { complete: missing === 0 && SEATS.every((seat) => deal.hands[seat].length === HAND_SIZE), missing }
}

const FORUM_PLAYER = (seat: Seat): PublicUser => ({ id: `forum:${seat}`, username: seat })

/**
 * Four hands as a history record, so a post draws them with the record pages' `RecordDiagram`
 * (AC-13.2: the same diagram). There is no board number (0), no players and no play.
 */
export function dealRecord(deal: ForumDeal): BoardRecord {
  return {
    id: 'forum',
    tableNumber: 0,
    finishedAt: 0,
    players: { N: FORUM_PLAYER('N'), E: FORUM_PLAYER('E'), S: FORUM_PLAYER('S'), W: FORUM_PLAYER('W') },
    board: {
      boardNo: 0,
      dealer: deal.dealer,
      vul: deal.vul,
      hands: deal.hands,
      auction: [],
      contract: null,
      play: [],
      phase: 'finished',
    },
  }
}

// ── An auction (e13-t06) ─────────────────────────────────────────────────────────────────────

/** An auction's calls, as many as the Worker takes (BLOCK_LIMITS.callsMax) */
export const CALLS_MAX = 120

/** An explanation of an alerted call (BLOCK_LIMITS.alertMax) */
export const ALERT_MAX = 200

export const emptyAuction = (dealer: Seat = 'N'): ForumAuction => ({ dealer, calls: [] })

/** The calls the next seat may make, in the bidding box's order; none once the auction is over or full */
export function nextCalls(auction: ForumAuction): Call[] {
  if (auction.calls.length >= CALLS_MAX) return []
  return [...legalCalls(auction.calls, auction.dealer)]
}

/** The auction with one more call; an illegal call leaves it as it was */
export function addCall(auction: ForumAuction, call: Call, alert?: string): ForumAuction {
  if (!nextCalls(auction).includes(call)) return auction
  const entry: ForumAuctionCall = { seat: seatToCall(auction.dealer, auction.calls.length), call }
  const explained = alert?.trim().slice(0, ALERT_MAX)
  if (alert !== undefined) entry.alert = explained ?? ''
  return { ...auction, calls: [...auction.calls, entry] }
}

export const undoCall = (auction: ForumAuction): ForumAuction => ({ ...auction, calls: auction.calls.slice(0, -1) })

/** The same calls started by another dealer: each call's seat moves with it (sides stay as they were) */
export function withDealer(auction: ForumAuction, dealer: Seat): ForumAuction {
  return { dealer, calls: auction.calls.map((c, i) => ({ ...c, seat: seatToCall(dealer, i) })) }
}

export type AuctionProblem = { kind: 'empty' } | { kind: 'illegal'; index: number } | { kind: 'tooLong' }

/** What the Worker would refuse in an auction: no calls, a call out of turn or against the rules */
export function auctionProblems(auction: ForumAuction): AuctionProblem[] {
  if (auction.calls.length === 0) return [{ kind: 'empty' }]
  if (auction.calls.length > CALLS_MAX) return [{ kind: 'tooLong' }]
  for (let i = 0; i < auction.calls.length; i++) {
    const { seat, call } = auction.calls[i]
    const before = auction.calls.slice(0, i)
    if (seat !== seatToCall(auction.dealer, i) || !legalCalls(before, auction.dealer).has(call)) return [{ kind: 'illegal', index: i }]
  }
  return []
}

/** Over (and its contract, none when passed out) or still running */
export function auctionStatus(auction: ForumAuction): { over: boolean; contract: Contract | null } {
  return { over: isAuctionComplete(auction.calls), contract: contractOf(auction.calls) }
}

// ── Text: a Markdown subset (e13-t04) ────────────────────────────────────────────────────────

/**
 * The post's text is written in a small Markdown, turned into the forum's text blocks (no HTML, no
 * inline styles: both sites draw text as text):
 *
 * - Paragraphs are separated by a blank line; line breaks inside one are kept. Paragraphs next to
 *   each other become one `paragraph` block (a post has at most 20 blocks).
 * - `- item` or `* item`: a list (`rules`); `1. item`: a numbered one. Two spaces of indent per
 *   level, at most three levels.
 * - `> text`: a note (`note`, info); `> [!WARNING]` on its first line makes it a warning.
 * - `!s !h !d !c` become ♠ ♥ ♦ ♣ (as on BBO), unless the `!` follows a Latin letter.
 * - A line starting with `\` is plain text (the `\` is dropped), so a paragraph may start with `-`.
 */
export type TextBlock = Extract<PostBlock, { kind: 'paragraph' | 'rules' | 'note' }>

const LIST_ITEM = /^(\s*)([-*]|\d{1,3}[.)])(?:\s+(.*))?$/
const QUOTE = /^\s*>\s?(.*)$/
const ALERT_TAG = /^\[!(warning|caution|important|note|info|tip)\]\s*$/i
const RULES_DEPTH = 3
const SUIT_SHORTCUT = /(?<![A-Za-z])!([shdcSHDC])/g
const SUIT_OF_SHORTCUT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' }

/** `!s` → ♠ and the other suits */
export const suitShortcuts = (text: string) => text.replace(SUIT_SHORTCUT, (_, s: string) => SUIT_OF_SHORTCUT[s.toLowerCase()])

/** Lines into chunks at blank lines */
function chunks(text: string): string[][] {
  const out: string[][] = []
  let current: string[] = []
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (current.length) out.push(current)
      current = []
    } else current.push(line.replace(/\s+$/, ''))
  }
  if (current.length) out.push(current)
  return out
}

function parseList(lines: string[]): TextBlock | null {
  const ordered = /\d/.test(LIST_ITEM.exec(lines[0])![2])
  const root: ForumRuleItem[] = []
  // The open item at each depth, and the indent it was written with
  const open: { item: ForumRuleItem; indent: number }[] = []
  for (const line of lines) {
    const match = LIST_ITEM.exec(line)
    if (!match) {
      // A line that carries on the item above
      const last = open.at(-1)
      if (last) last.item.text = `${last.item.text} ${suitShortcuts(line.trim())}`.trim()
      continue
    }
    const indent = match[1].replace(/\t/g, '  ').length
    while (open.length && open.at(-1)!.indent >= indent) open.pop()
    if (open.length >= RULES_DEPTH) open.length = RULES_DEPTH - 1
    const item: ForumRuleItem = { text: suitShortcuts((match[3] ?? '').trim()) }
    const parent = open.at(-1)
    if (parent) (parent.item.children ??= []).push(item)
    else root.push(item)
    open.push({ item, indent })
  }
  const prune = (items: ForumRuleItem[]): ForumRuleItem[] =>
    items.flatMap((item) => {
      const children = item.children ? prune(item.children) : []
      if (!item.text) return children
      return [children.length ? { text: item.text, children } : { text: item.text }]
    })
  const items = prune(root)
  if (!items.length) return null
  return ordered ? { kind: 'rules', items, ordered: true } : { kind: 'rules', items }
}

function parseNote(lines: string[]): TextBlock | null {
  const body = lines.map((line) => QUOTE.exec(line)?.[1] ?? line.trim())
  let tone: 'info' | 'warning' = 'info'
  const tag = ALERT_TAG.exec(body[0] ?? '')
  if (tag) {
    tone = /warning|caution|important/i.test(tag[1]) ? 'warning' : 'info'
    body.shift()
  }
  const text = suitShortcuts(body.join('\n').trim())
  return text ? { kind: 'note', tone, text } : null
}

/** Markdown-subset text as the forum's text blocks; none for blank text */
export function parseMarkdown(text: string): TextBlock[] {
  const blocks: TextBlock[] = []
  for (const lines of chunks(text)) {
    const first = lines[0]
    let block: TextBlock | null
    if (first.trimStart().startsWith('\\')) {
      const [head, ...rest] = lines
      block = { kind: 'paragraph', text: suitShortcuts([head.trimStart().slice(1), ...rest].join('\n')).trim() }
    } else if (LIST_ITEM.test(first)) block = parseList(lines)
    else if (QUOTE.test(first)) block = parseNote(lines)
    else block = { kind: 'paragraph', text: suitShortcuts(lines.join('\n')).trim() }
    if (!block || (block.kind === 'paragraph' && !block.text)) continue
    const last = blocks.at(-1)
    if (block.kind === 'paragraph' && last?.kind === 'paragraph') last.text = `${last.text}\n\n${block.text}`
    else blocks.push(block)
  }
  return blocks
}

/** A paragraph's chunk that would read as a list or a note is marked as plain text */
function escapeChunk(chunk: string) {
  const first = chunk.split('\n')[0]
  return LIST_ITEM.test(first) || QUOTE.test(first) || first.trimStart().startsWith('\\') ? `\\${chunk}` : chunk
}

function listMarkdown(items: ForumRuleItem[], ordered: boolean, depth = 0): string[] {
  return items.flatMap((item, i) => [
    `${'  '.repeat(depth)}${ordered ? `${i + 1}.` : '-'} ${item.text.replace(/\s*\n\s*/g, ' ')}`,
    ...(item.children ? listMarkdown(item.children, ordered, depth + 1) : []),
  ])
}

/** Text blocks back as the Markdown subset, for editing a post (`parseMarkdown` reads it back the same) */
export function toMarkdown(blocks: readonly TextBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === 'paragraph')
        return block.text
          .split(/\n\s*\n/)
          .map((chunk) => escapeChunk(chunk.trim()))
          .join('\n\n')
      if (block.kind === 'rules') return listMarkdown(block.items, !!block.ordered).join('\n')
      const lines = block.text.split('\n').map((line) => (line ? `> ${line}` : '>'))
      return (block.tone === 'warning' ? ['> [!WARNING]', ...lines] : lines).join('\n')
    })
    .join('\n\n')
}

// ── The post as the editor holds it ──────────────────────────────────────────────────────────

/**
 * The editor's pieces, in order: text in the Markdown subset, four hands, an auction, or a block
 * the table's editor does not edit (one hand, a picture, a handbook quote, a table record, from a
 * post written on BridgeHall), which is kept as it was and may only be moved or removed.
 */
export type EditorPiece =
  | { kind: 'text'; text: string }
  | { kind: 'deal'; deal: ForumDeal; caption: string }
  | { kind: 'auction'; auction: ForumAuction; caption: string }
  | { kind: 'kept'; block: PostBlock }

const isTextBlock = (block: PostBlock): block is TextBlock => block.kind === 'paragraph' || block.kind === 'rules' || block.kind === 'note'

/** A post's blocks as pieces to edit: text blocks next to each other become one piece of text */
export function piecesOf(blocks: readonly PostBlock[]): EditorPiece[] {
  const pieces: EditorPiece[] = []
  let text: TextBlock[] = []
  const flush = () => {
    if (text.length) pieces.push({ kind: 'text', text: toMarkdown(text) })
    text = []
  }
  for (const block of blocks) {
    if (isTextBlock(block)) {
      text.push(block)
      continue
    }
    flush()
    if (block.kind === 'deal') pieces.push({ kind: 'deal', deal: block.deal, caption: block.caption ?? '' })
    else if (block.kind === 'auction') pieces.push({ kind: 'auction', auction: block.auction, caption: block.caption ?? '' })
    else pieces.push({ kind: 'kept', block })
  }
  flush()
  return pieces
}

const withCaption = <T extends object>(block: T, caption: string): T & { caption?: string } => {
  const clean = caption.trim().slice(0, CAPTION_MAX)
  return clean ? { ...block, caption: clean } : block
}

/** The blocks the editor sends: empty text, hands without cards and auctions without calls left out */
export function blocksOf(pieces: readonly EditorPiece[]): PostBlock[] {
  return pieces.flatMap((piece): PostBlock[] => {
    switch (piece.kind) {
      case 'text':
        return parseMarkdown(piece.text)
      case 'deal':
        return SEATS.some((seat) => piece.deal.hands[seat].length)
          ? [withCaption({ kind: 'deal' as const, deal: { ...piece.deal, hands: sortedHands(piece.deal.hands) } }, piece.caption)]
          : []
      case 'auction':
        return piece.auction.calls.length ? [withCaption({ kind: 'auction' as const, auction: piece.auction }, piece.caption)] : []
      case 'kept':
        return [piece.block]
    }
  })
}

const sortedHands = (hands: Hands): Hands => ({ N: sortHand(hands.N), E: sortHand(hands.E), S: sortHand(hands.S), W: sortHand(hands.W) })

/** The dealer a new deal or auction starts with: the last deal's or auction's in the post, else North */
export function dealerFor(pieces: readonly EditorPiece[]): Seat {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i]
    if (piece.kind === 'deal') return piece.deal.dealer
    if (piece.kind === 'auction') return piece.auction.dealer
  }
  return 'N'
}

/** The words of a block that count towards the text limit, as the Worker counts them */
function blockWords(block: PostBlock): string[] {
  if (block.kind === 'paragraph' || block.kind === 'note') return [block.text]
  if (block.kind !== 'rules') return []
  const all: string[] = []
  const walk = (items: ForumRuleItem[]) =>
    items.forEach((item) => {
      all.push(item.text)
      if (item.children) walk(item.children)
    })
  walk(block.items)
  return all
}

/** Characters of text in these blocks, one per code point (as the Worker counts) */
export const textLength = (blocks: readonly PostBlock[]) => blocks.flatMap(blockWords).reduce((sum, t) => sum + [...t].length, 0)

export type PostProblem =
  | { kind: 'empty' }
  | { kind: 'tooManyBlocks'; max: number }
  | { kind: 'tooLong'; length: number; max: number }
  | { kind: 'titleTooLong'; max: number }
  | { kind: 'deal'; problem: DealProblem }
  | { kind: 'auction'; problem: AuctionProblem }

/** What stops a post from being sent, before the Worker sees it */
export function postProblems(title: string, blocks: readonly PostBlock[]): PostProblem[] {
  const problems: PostProblem[] = []
  if (blocks.length === 0) problems.push({ kind: 'empty' })
  if (blocks.length > FORUM_LIMITS.blocksMax) problems.push({ kind: 'tooManyBlocks', max: FORUM_LIMITS.blocksMax })
  const length = textLength(blocks)
  if (length > FORUM_LIMITS.postTextMax) problems.push({ kind: 'tooLong', length, max: FORUM_LIMITS.postTextMax })
  if ([...title.trim()].length > FORUM_LIMITS.titleMax) problems.push({ kind: 'titleTooLong', max: FORUM_LIMITS.titleMax })
  for (const block of blocks) {
    if (block.kind === 'deal') problems.push(...dealProblems(block.deal).map((problem) => ({ kind: 'deal' as const, problem })))
    if (block.kind === 'auction') problems.push(...auctionProblems(block.auction).map((problem) => ({ kind: 'auction' as const, problem })))
  }
  return problems
}

// ── The draft on this device ─────────────────────────────────────────────────────────────────

export interface PostDraft {
  boardId: string
  title: string
  blocks: PostBlock[]
}

export function isPostDraft(value: unknown): value is PostDraft {
  if (typeof value !== 'object' || value === null) return false
  const draft = value as PostDraft
  return typeof draft.boardId === 'string' && typeof draft.title === 'string' && Array.isArray(draft.blocks)
}
