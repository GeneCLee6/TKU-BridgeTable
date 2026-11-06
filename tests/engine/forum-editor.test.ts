import { describe, expect, it } from 'vitest'
import { deal as randomDeal } from '../../shared/board.ts'
import { fullDeck, SEATS } from '../../shared/cards.ts'
import { FORUM_LIMITS, type ForumAuction, type PostBlock } from '../../shared/forum.ts'
import {
  ALT_MAX,
  addCall,
  auctionProblems,
  auctionStatus,
  blocksOf,
  dealerFor,
  dealProblems,
  dealRecord,
  dealStatus,
  emptyAuction,
  emptyDeal,
  emptyHands,
  fillRemaining,
  lastSeatToFill,
  nextCalls,
  parseMarkdown,
  piecesOf,
  postProblems,
  seatToFill,
  suitShortcuts,
  toggleCard,
  toMarkdown,
  unassignedCards,
  undoCall,
  withDealer,
} from '../../shared/forum-editor.ts'

/** The post editor's pure parts (E13 K2: e13-t04, e13-t05, e13-t06) */

describe('four hands (e13-t05)', () => {
  it('gives a card to the chosen seat, takes it back, and moves it from another seat', () => {
    let hands = toggleCard(emptyHands(), 'N', 'SA')
    expect(hands.N).toEqual(['SA'])
    hands = toggleCard(hands, 'E', 'SA')
    expect(hands.N).toEqual([])
    expect(hands.E).toEqual(['SA'])
    hands = toggleCard(hands, 'E', 'SA')
    expect(hands.E).toEqual([])
  })

  it('never puts a 14th card in a hand', () => {
    let hands = emptyHands()
    for (const card of fullDeck().slice(0, 14)) hands = toggleCard(hands, 'S', card)
    expect(hands.S).toHaveLength(13)
    expect(seatToFill(hands, 'S')).toBe('W')
  })

  it('gives the rest of the pack to the last hand and checks 52 different cards, 13 each', () => {
    const full = randomDeal()
    const hands = { ...full, W: [] }
    expect(lastSeatToFill(hands)).toBe('W')
    const filled = fillRemaining(hands)
    expect(filled.W).toHaveLength(13)
    expect(unassignedCards(filled)).toEqual([])
    expect(dealStatus({ hands: filled, dealer: 'N', vul: 'None' })).toEqual({ complete: true, missing: 0 })
    expect(dealProblems({ hands: filled, dealer: 'N', vul: 'None' })).toEqual([])
  })

  it('allows a partial deal, and refuses a card twice, a hand over 13 or no cards', () => {
    const partial = { hands: { N: ['SA', 'SK'], E: [], S: ['HA'], W: [] }, dealer: 'S' as const, vul: 'NS' as const }
    expect(dealProblems(partial)).toEqual([])
    expect(dealStatus(partial)).toEqual({ complete: false, missing: 49 })
    expect(dealProblems(emptyDeal())).toEqual([{ kind: 'empty' }])
    expect(dealProblems({ ...partial, hands: { ...partial.hands, E: ['SA'] } })).toEqual([{ kind: 'duplicate', card: 'SA' }])
    expect(dealProblems({ ...partial, hands: { ...partial.hands, W: fullDeck().slice(-14) } })).toEqual([{ kind: 'tooMany', seat: 'W' }])
  })

  it('makes a record the record pages’ diagram can draw', () => {
    const record = dealRecord({ hands: { N: ['SA'], E: [], S: [], W: [] }, dealer: 'E', vul: 'Both' })
    expect(record.board).toMatchObject({ boardNo: 0, dealer: 'E', vul: 'Both', play: [], auction: [] })
    expect(SEATS.map((s) => record.players[s].username)).toEqual(['N', 'E', 'S', 'W'])
  })
})

describe('an auction (e13-t06)', () => {
  const bid = (auction: ForumAuction, ...calls: string[]) => calls.reduce((a, c) => addCall(a, c), auction)

  it('takes only legal calls, each by the seat in turn', () => {
    let auction = bid(emptyAuction('E'), '1S', 'X')
    expect(auction.calls).toEqual([
      { seat: 'E', call: '1S' },
      { seat: 'S', call: 'X' },
    ])
    expect(nextCalls(auction)).toContain('XX')
    // 1♣ is below 1♠; X of partner's double is not allowed
    expect(addCall(auction, '1C')).toBe(auction)
    auction = bid(auction, 'P')
    expect(addCall(auction, 'X')).toBe(auction)
    expect(auctionProblems(auction)).toEqual([])
  })

  it('keeps an alert and its explanation', () => {
    expect(addCall(emptyAuction(), '2C', '  強牌 ').calls[0]).toEqual({ seat: 'N', call: '2C', alert: '強牌' })
    expect(addCall(emptyAuction(), '2C', '').calls[0]).toEqual({ seat: 'N', call: '2C', alert: '' })
  })

  it('knows when it is over and the contract', () => {
    const auction = bid(emptyAuction('S'), '1H', 'P', '4H', 'P', 'P', 'P')
    expect(auctionStatus(auction)).toMatchObject({ over: true, contract: { level: 4, strain: 'H', declarer: 'S' } })
    expect(nextCalls(auction)).toEqual([])
    expect(auctionStatus(undoCall(auction)).over).toBe(false)
    expect(auctionStatus(bid(emptyAuction(), 'P', 'P', 'P', 'P'))).toEqual({ over: true, contract: null })
  })

  it('moves the seats with a new dealer and catches calls the Worker would refuse', () => {
    const auction = withDealer(bid(emptyAuction('N'), '1C', 'X'), 'W')
    expect(auction.calls.map((c) => c.seat)).toEqual(['W', 'N'])
    expect(auctionProblems(auction)).toEqual([])
    expect(auctionProblems(emptyAuction())).toEqual([{ kind: 'empty' }])
    expect(auctionProblems({ dealer: 'N', calls: [{ seat: 'E', call: '1C' }] })).toEqual([{ kind: 'illegal', index: 0 }])
    expect(auctionProblems({ dealer: 'N', calls: [{ seat: 'N', call: '1C' }, { seat: 'E', call: '1C' }] })).toEqual([{ kind: 'illegal', index: 1 }])
  })
})

describe('the Markdown subset (e13-t04)', () => {
  it('turns paragraphs, lists and notes into the forum’s text blocks', () => {
    const text = [
      '這副牌怎麼叫？',
      '第二行',
      '',
      '第二段 1!s',
      '',
      '- 開叫 1!h',
      '  - 答叫 1!s',
      '- 再叫',
      '',
      '1. 第一',
      '2. 第二',
      '',
      '> [!WARNING]',
      '> 小心 !c',
      '',
      '> 一般提示',
    ].join('\n')
    expect(parseMarkdown(text)).toEqual<PostBlock[]>([
      { kind: 'paragraph', text: '這副牌怎麼叫？\n第二行\n\n第二段 1♠' },
      { kind: 'rules', items: [{ text: '開叫 1♥', children: [{ text: '答叫 1♠' }] }, { text: '再叫' }] },
      { kind: 'rules', items: [{ text: '第一' }, { text: '第二' }], ordered: true },
      { kind: 'note', tone: 'warning', text: '小心 ♣' },
      { kind: 'note', tone: 'info', text: '一般提示' },
    ])
  })

  it('reads nothing from blank text and drops empty list items', () => {
    expect(parseMarkdown('  \n\n ')).toEqual([])
    expect(parseMarkdown('- \n- a')).toEqual([{ kind: 'rules', items: [{ text: 'a' }] }])
    expect(parseMarkdown('>')).toEqual([])
  })

  it('keeps lists at most three levels deep', () => {
    const [rules] = parseMarkdown('- a\n  - b\n    - c\n      - d')
    expect(rules).toEqual({ kind: 'rules', items: [{ text: 'a', children: [{ text: 'b', children: [{ text: 'c' }, { text: 'd' }] }] }] })
  })

  it('turns suit shortcuts into symbols, but not inside a word', () => {
    expect(suitShortcuts('1!S - 2!h, 3!D 4!c')).toBe('1♠ - 2♥, 3♦ 4♣')
    expect(suitShortcuts('wow!so')).toBe('wow!so')
  })

  it('writes blocks back as text that reads the same', () => {
    const blocks: PostBlock[] = [
      { kind: 'paragraph', text: '- 不是清單\n第二行\n\n> 也不是提示' },
      { kind: 'rules', items: [{ text: 'a', children: [{ text: 'b' }] }], ordered: true },
      { kind: 'note', tone: 'warning', text: '注意\n兩行' },
      { kind: 'note', tone: 'info', text: '提示' },
    ]
    const text = toMarkdown(blocks as never)
    expect(parseMarkdown(text)).toEqual(blocks)
  })
})

describe('the post as the editor holds it', () => {
  const deal = { hands: { N: ['SK', 'SA'], E: [], S: [], W: [] }, dealer: 'W' as const, vul: 'EW' as const }
  const blocks: PostBlock[] = [
    { kind: 'paragraph', text: '問題' },
    { kind: 'rules', items: [{ text: 'a' }] },
    { kind: 'deal', deal, caption: '第 3 副' },
    { kind: 'image', assetId: 'post/x.png', alt: '' },
    { kind: 'auction', auction: { dealer: 'W', calls: [{ seat: 'W', call: '1N' }] } },
    { kind: 'hand', cards: ['SA'] },
  ]

  it('edits the text blocks next to each other as one piece and keeps what it does not edit', () => {
    const pieces = piecesOf(blocks)
    expect(pieces.map((p) => p.kind)).toEqual(['text', 'deal', 'image', 'auction', 'kept'])
    // A picture is edited here (e13-t13): its alternative text and caption
    expect(pieces[2]).toEqual({ kind: 'image', assetId: 'post/x.png', alt: '', caption: '' })
    expect(pieces[0]).toEqual({ kind: 'text', text: '問題\n\n- a' })
    expect(dealerFor(pieces)).toBe('W')
    expect(blocksOf(pieces)).toEqual([
      blocks[0],
      blocks[1],
      // The hands are sent sorted
      { kind: 'deal', deal: { ...deal, hands: { N: ['SA', 'SK'], E: [], S: [], W: [] } }, caption: '第 3 副' },
      blocks[3],
      blocks[4],
      blocks[5],
    ])
  })

  it('sends a picture with its trimmed alternative text and caption (e13-t13)', () => {
    expect(blocksOf([{ kind: 'image', assetId: 'post/x.gif', alt: ' 牌桌 ', caption: ' 第一副 ' }])).toEqual([
      { kind: 'image', assetId: 'post/x.gif', alt: '牌桌', caption: '第一副' },
    ])
    expect(blocksOf([{ kind: 'image', assetId: 'post/x.gif', alt: 'x'.repeat(300), caption: '' }])[0]).toEqual({
      kind: 'image',
      assetId: 'post/x.gif',
      alt: 'x'.repeat(ALT_MAX),
    })
    const seven = Array.from({ length: FORUM_LIMITS.imagesMax + 1 }, () => ({ kind: 'image' as const, assetId: 'post/x.png', alt: '' }))
    expect(postProblems('', seven)).toContainEqual({ kind: 'tooManyImages', max: FORUM_LIMITS.imagesMax })
  })

  it('leaves out empty pieces and blank captions', () => {
    expect(blocksOf([{ kind: 'text', text: ' ' }, { kind: 'deal', deal: emptyDeal(), caption: 'x' }, { kind: 'auction', auction: emptyAuction(), caption: '' }])).toEqual([])
    expect(blocksOf([{ kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'N', call: 'P' }] }, caption: '  ' }])).toEqual([
      { kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'N', call: 'P' }] } },
    ])
  })

  it('says what stops a post before the Worker does', () => {
    expect(postProblems('', [])).toEqual([{ kind: 'empty' }])
    expect(postProblems('x'.repeat(81), [{ kind: 'paragraph', text: '字'.repeat(5001) }])).toEqual([
      { kind: 'tooLong', length: 5001, max: 5000 },
      { kind: 'titleTooLong', max: 80 },
    ])
    expect(postProblems('', Array.from({ length: 21 }, () => ({ kind: 'paragraph' as const, text: 'a' })))).toContainEqual({ kind: 'tooManyBlocks', max: 20 })
    expect(postProblems('', [{ kind: 'deal', deal: { ...deal, hands: { ...deal.hands, E: ['SA'] } } }])).toEqual([
      { kind: 'deal', problem: { kind: 'duplicate', card: 'SA' } },
    ])
    expect(postProblems('', blocks)).toEqual([])
  })
})
