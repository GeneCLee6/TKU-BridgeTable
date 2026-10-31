import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { narrow } from '../../shared/robot/system/combine.ts'
import { contextFor, intersect, read } from '../../shared/robot/system/infer.ts'
import { ANY, type System } from '../../shared/robot/system/spec.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { LANGS } from '../../shared/messages.ts'

function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function auctionOf(calls: string, dealer: Seat = 'N'): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

const toy: System = {
  id: 'gib',
  books: [
    {
      after: '',
      rules: [
        { call: '1N', shows: { hcp: [15, 17], balanced: true } },
        { call: '1S', shows: { hcp: [11, 21], len: { S: [5, 13] } } },
        { call: 'P', shows: { hcp: [0, 11] } },
      ],
    },
    {
      after: '1N (P)',
      rules: [
        { call: '2C', shows: { name: 'stayman', hcp: [8, ANY], forcing: 'oneRound', artificial: true }, when: (h) => h.len.H >= 4 || h.len.S >= 4 },
        { call: '2D', shows: { name: 'transfer', len: { H: [5, 13] }, forcing: 'oneRound', artificial: true } },
        { call: '3C', shows: { len: { C: [5, 13] }, hcp: [10, ANY], forcing: 'game' } },
        { call: 'P', shows: { hcp: [0, 7] } },
      ],
    },
    {
      after: '1N (P) 2C (P)',
      rules: [
        { call: '2H', shows: { len: { H: [4, 4] } } },
        { call: '2D', shows: { len: { H: [0, 3], S: [0, 3] } } },
      ],
    },
    // Opener rebids without a rule for it: nothing but a pass is written, so pass is the only option
    { after: '1N (P) 2D (P)', rules: [{ call: 'P' }, { call: '2H', shows: { len: { H: [2, 5] } } }] },
    { after: '1N (P) 3C (P)', rules: [{ call: 'P' }, { call: '3N', shows: { hcp: [15, 17] } }] },
    { after: '1N (P) 3C (P) 3N (P)', rules: [{ call: 'P' }] },
  ],
}

describe('intersect: one player, several calls', () => {
  it('narrows each feature to what all the calls show', () => {
    expect(intersect({ hcp: [15, 17], balanced: true }, { len: { H: [4, 4] } })).toEqual({ hcp: [15, 17], len: { H: [4, 4] }, balanced: true })
    expect(intersect({ hcp: [11, 21], len: { S: [5, 13] } }, { hcp: [11, 14], len: { S: [6, 13] } })).toEqual({ hcp: [11, 14], len: { S: [6, 13] } })
    expect(intersect({ stop: { D: 'likely' } }, { stop: { D: 'stop' } })).toEqual({ stop: { D: 'stop' } })
  })

  it('lets the newer call win when the two do not overlap', () => {
    expect(intersect({ hcp: [0, 7] }, { hcp: [10, 12] })).toEqual({ hcp: [10, 12] })
  })

  it('keeps only hand features', () => {
    expect(intersect({}, { name: 'stayman', hcp: [8, ANY], forcing: 'oneRound', artificial: true })).toEqual({ hcp: [8, ANY] })
  })
})

describe('reading the auction', () => {
  it('collects what each seat has shown, opponents too', () => {
    const reading = read(toy, auctionOf('1N P 2C P 2H P'), 'N', 'None')
    expect(reading.shown.N).toEqual({ hcp: [15, 17], len: { H: [4, 4] }, balanced: true })
    expect(reading.shown.S).toEqual({ hcp: [8, ANY] })
    // East's pass over 1NT is outside the books: nothing learnt
    expect(reading.shown.E).toEqual({})
    expect(read(toy, auctionOf('P P 1N'), 'N', 'None').shown.N).toEqual({ hcp: [0, 11] })
  })

  it('shows the inference to the rules, by role', () => {
    const ctx = contextFor(toy, 'S', auctionOf('1N P'), 'N', 'None')
    expect(ctx.shown.partner).toEqual({ hcp: [15, 17], balanced: true })
    expect(ctx.shown.me).toEqual({})
  })

  it('does not pass a forcing call', () => {
    // After the transfer the 1NT book above has pass first; it may not be used
    const ctx = contextFor(toy, 'N', auctionOf('1N P 2D P'), 'N', 'None')
    expect(ctx.forced).toBe(true)
    expect(choose(toy, hand('AQ2 KJ3 Q54 K432'), 'N', auctionOf('1N P 2D P'), 'N').call).toBe('2H')
    expect(explain(toy, auctionOf('1N P 2D P'), 'N').has('P')).toBe(false)
  })

  it('keeps bidding to game after a game force, but may stop there', () => {
    expect(choose(toy, hand('AQ2 KJ3 Q54 K432'), 'N', auctionOf('1N P 3C P'), 'N').call).toBe('3N')
    const ctx = contextFor(toy, 'S', auctionOf('1N P 3C P 3N P'), 'N', 'None')
    expect(ctx.forced).toBe(false)
  })

  it('is freed by an opponent who bids or doubles', () => {
    expect(contextFor(toy, 'N', auctionOf('1N P 2D X'), 'N', 'None').forced).toBe(false)
  })

  it('makes the emergency call when forced and no rule fits', () => {
    // After the transfer only 2♥ with two to five hearts fits; a void needs the emergency call
    const strict: System = { ...toy, emergency: () => '2S' }
    expect(choose(strict, hand('AQ32 - KJ54 AQ432'), 'N', auctionOf('1N P 2D P'), 'N').call).toBe('2S')
    expect(choose(toy, hand('AQ32 - KJ54 AQ432'), 'N', auctionOf('1N P 2D P'), 'N').call).toBe('P')
  })

  it('may still pass to leave partner’s double in for penalty', () => {
    // North opens, East doubles for takeout, South passes: West may not pass, except for penalty
    const doubling: System = {
      id: 'gib',
      books: [
        { after: '(1H)', rules: [{ call: 'X', shows: { forcing: 'oneRound' } }] },
        { after: '(1H) X (P)', rules: [{ call: 'P', shows: { name: 'penalty' } }, { call: 'P', shows: {} }, { call: '1S' }] },
      ],
    }
    const calls = explain(doubling, auctionOf('1H X P'), 'N')
    expect(calls.get('P')).toEqual({ name: 'penalty' })
    expect(choose(doubling, hand('AQ32 KJ54 32 Q32'), 'W', auctionOf('1H X P'), 'N').call).toBe('P')
  })
})

describe('narrow: each explanation within what the player showed (Y2)', () => {
  it('narrows the features a call mentions, keeps its name and forcing, adds nothing', () => {
    expect(narrow({ name: 'stayman', hcp: [8, ANY], forcing: 'oneRound' }, { hcp: [0, 11], len: { S: [0, 4] } })).toEqual({ name: 'stayman', hcp: [8, 11], forcing: 'oneRound' })
    expect(narrow({ len: { S: [3, 13], H: [0, 3] } }, { len: { S: [5, 13] } })).toEqual({ len: { S: [5, 13], H: [0, 3] } })
    const spec = { hcp: [12, 14] as [number, number] }
    expect(narrow(spec, { hcp: [11, 15] })).toBe(spec)
    // Ranges that do not overlap: the newer one, as `intersect`
    expect(narrow({ hcp: [0, 5] }, { hcp: [11, 15] })).toEqual({ hcp: [0, 5] })
  })

  it('never changes what the player has shown in all', () => {
    const known = { hcp: [0, 11] as [number, number], len: { S: [4, 13] as [number, number] } }
    const spec = { hcp: [8, ANY] as [number, number], len: { S: [3, 13] as [number, number], H: [4, 13] as [number, number] } }
    expect(intersect(known, narrow(spec, known))).toEqual(intersect(known, spec))
  })

  it('explains a passed hand bidding Stayman as 8–11, not 8+, for the hints, the alert and partner', () => {
    const auction = auctionOf('P P 1N P')
    expect(explain(toy, auction, 'N').get('2C')).toEqual({ name: 'stayman', hcp: [8, 11], forcing: 'oneRound', artificial: true })
    expect(explain(toy, auction, 'N').get('3C')?.hcp).toEqual([10, 11])
    expect(choose(toy, hand('AQ32 K32 Q54 432'), 'N', auction, 'N')).toEqual({ call: '2C', shows: { name: 'stayman', hcp: [8, 11], forcing: 'oneRound', artificial: true } })
    expect(contextFor(toy, 'S', [...auction, { seat: 'N', call: '2C' }, { seat: 'E', call: 'P' }], 'N', 'None').said.partner?.hcp).toEqual([8, 11])
  })
})

describe('narrow, full: every explanation tells all the player has shown (Z1)', () => {
  const known = { hcp: [15, 17] as [number, number], balanced: true, len: { S: [0, 13] as [number, number], H: [5, 13] as [number, number] }, stop: { D: 'stop' as const } }

  it('adds what the call does not mention as `before`, leaving out ranges that say nothing', () => {
    expect(narrow({ name: 'rkcb', forcing: 'oneRound' }, known, true)).toEqual({
      name: 'rkcb',
      forcing: 'oneRound',
      before: { hcp: [15, 17], len: { H: [5, 13] }, stop: { D: 'stop' }, balanced: true },
    })
    // What the call mentions stays the call's, narrowed as without `full`
    expect(narrow({ hcp: [16, ANY], len: { H: [6, 13] } }, known, true)).toEqual({ hcp: [16, 17], len: { H: [6, 13] }, before: { stop: { D: 'stop' }, balanced: true } })
    expect(narrow({ hcp: [12, 14] }, {}, true)).toEqual({ hcp: [12, 14] })
    expect(narrow({}, { keycards: [1, 4], trumpQueen: false }, true)).toEqual({ before: { keycards: [1, 4], trumpQueen: false } })
  })

  it('changes nothing the robots read: the rest of the meaning and what the player has shown in all', () => {
    const spec = { name: 'stayman' as const, hcp: [8, ANY] as [number, number], forcing: 'oneRound' as const }
    const { before, ...rest } = narrow(spec, known, true)
    expect(before).toBeDefined()
    expect(rest).toEqual(narrow(spec, known))
    expect(intersect(known, narrow(spec, known, true))).toEqual(intersect(known, spec))
  })

  it('explains RKCB with what the asker had shown, and a later answer with the keycards shown', () => {
    const auction = auctionOf('1S P 3C P 3D P 4C P')
    expect(words(explain(TKU, auction, 'N').get('4N')!, 'zh')).toBe('RKCB 1430：有滿貫興趣，迫叫一圈\n已表示：5+ 張♠，14–21 大牌點')
    expect(words(explain(TKU, auction, 'N').get('4N')!, 'en')).toBe('RKCB 1430: slam interest; forcing\nShown so far: 5+ ♠; 14–21 HCP')
    // The call's own meaning alone, as partner reads it
    expect(words(explain(TKU, auction, 'N', 'None', false).get('4N')!, 'zh')).toBe('RKCB 1430：有滿貫興趣，迫叫一圈')
    expect(words(explain(TKU, auctionOf('1S P 3C P 3D P 4C P 4N P 5C P 5D P'), 'N').get('5S')!, 'zh')).toBe(
      '回答關鍵張：沒有王牌 Q\n已表示：4+ 張♠，1 張♣，10–11 大牌點，1 或 4 張關鍵張',
    )
    // A pass that shows nothing of its own still tells what was shown
    expect(words(explain(TKU, auctionOf('1S P 2S P'), 'N').get('P')!, 'zh')).toBe('已表示：5+ 張♠，12–21 大牌點')
  })

  it('gives every language a lead-in for the second line', () => {
    const spec = { name: 'rkcb' as const, before: { hcp: [15, 17] as [number, number] } }
    for (const lang of LANGS) expect(words(spec, lang).split('\n')).toHaveLength(2)
  })
})
