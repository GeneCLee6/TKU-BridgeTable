import { describe as group, expect, it } from 'vitest'
import shipped from 'virtual:system-card-gib'
import type { Call } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
import { rankValue, RANKS, type Seat } from '../../shared/cards.ts'
import { LEAD_HOLDINGS, SIGNAL_IDS } from '../../shared/robot/card-play.ts'
import { CARD_SECTIONS, deriveCard, type CardCall, type SystemCard } from '../../shared/robot/system/card.ts'
import type { Ctx } from '../../shared/robot/system/context.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose } from '../../shared/robot/system/engine.ts'
import { evaluate, fits } from '../../shared/robot/system/evaluate.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'
import { openings as gibOpenings } from '../../shared/robot/system/gib/openings.ts'
import { resolve } from '../../shared/robot/system/rules.ts'
import type { Book, Spec, System } from '../../shared/robot/system/spec.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { openings as tkuOpenings } from '../../shared/robot/system/tku/openings.ts'
import { LANGS } from '../../shared/messages.ts'
import { STRINGS } from '../../src/strings.ts'

const SEEDED = (seed: number) => {
  let a = seed
  return (n: number) => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) % n
  }
}

const cards = { tku: deriveCard(TKU), gib: deriveCard(GIB) }

const groupOf = (card: SystemCard, section: string, after: string, seat?: number) => {
  const found = card.sections.find((s) => s.id === section)?.groups.find((g) => g.after === after && g.seat === seat)
  if (!found) throw new Error(`no group ${section} ${after} ${seat}`)
  return found
}
const callOn = (card: SystemCard, section: string, after: string, call: Call, seat?: number): CardCall => {
  const row = groupOf(card, section, after, seat).calls.find((c) => c.call === call)
  if (!row) throw new Error(`no ${call} after '${after}'`)
  return row
}

/** What the system file itself says a call shows, read directly from the book's rule */
const ruleShows = (book: Book, call: Call): Spec => {
  const rule = book.rules.find((r) => r.call === call)
  if (!rule) throw new Error(`no rule for ${call}`)
  return resolve(rule.shows, { position: 1 } as Ctx) ?? {}
}

group('the system card says what the system files say', () => {
  // A deliberately pinned sample of what the club and BBO's published 2/1 agree on or differ in: if a
  // system file changes one of these, this fails, and so does anything that makes the card lie
  it.each([
    ['tku', '1N', [15, 17]],
    ['gib', '1N', [15, 17]],
    ['tku', '2N', [20, 21]],
    ['gib', '2N', [20, 21]],
    ['tku', '1S', [12, 21]],
    ['gib', '1S', [11, 21]],
    ['tku', '3S', [5, 10]],
    ['gib', '3S', [5, 10]],
    ['tku', '2D', [5, 10]],
  ] as const)('%s opening %s is %j points', (system, call, hcp) => {
    expect(callOn(cards[system], 'openings', '', call).shows.hcp).toEqual(hcp)
  })

  it('opening requirements come from the system file', () => {
    for (const call of ['1C', '1D', '1H', '1S', '1N', '2C', '2N', '2H', '2S', '2D', '3H', '4S']) {
      expect(callOn(cards.tku, 'openings', '', call).shows).toEqual(ruleShows(tkuOpenings, call))
    }
    for (const call of ['1N', '2C', '2N', '2H', '2S', '2D', '3H', '4S']) {
      expect(callOn(cards.gib, 'openings', '', call).shows).toEqual(ruleShows(gibOpenings, call))
    }
    for (const call of ['1C', '1D', '1H', '1S']) {
      const rule = gibOpenings.rules.find((r) => r.call === call)!
      expect(callOn(cards.gib, 'openings', '', call).shows).toEqual(resolve(rule.shows, { position: 1 } as Ctx))
    }
  })

  it('tells the two systems apart where they differ', () => {
    // 1♣: as few as two in the club's 5542, three in 2/1
    expect(callOn(cards.tku, 'openings', '', '1C').shows.len?.C).toEqual([2, 13])
    expect(callOn(cards.gib, 'openings', '', '1C').shows.len?.C).toEqual([3, 13])
    // 2♥: a two-suiter for the club (社長 2026-10-25), a weak two in 2/1
    expect(callOn(cards.tku, 'twoLevel', '', '2H').shows.name).toBe('twoSuiter')
    expect(callOn(cards.gib, 'twoLevel', '', '2H').shows.name).toBe('weakTwo')
    // 1♠ 2NT: the club's J2N is three-card support and 12+, 2/1's Jacoby four-card
    expect(callOn(cards.tku, 'oneLevel', '1S (P)', '2N').shows.name).toBe('j2n')
    expect(callOn(cards.gib, 'oneLevel', '1S (P)', '2N').shows.name).toBe('jacoby2N')
    // RKCB: 1430 for the club, 0314 in 2/1
    expect(callOn(cards.tku, 'slam', '1H (P) 1S (P) 2S (P)', '4N').shows.name).toBe('rkcb1430')
    expect(callOn(cards.gib, 'slam', '1H (P) 1S (P) 2S (P)', '4N').shows.name).toBe('rkcb')
    expect(callOn(cards.tku, 'slam', '1S (P) 2N (P) 4N (P)', '5C').shows.keycards).toEqual([1, 4])
    expect(callOn(cards.gib, 'slam', '1S (P) 2N (P) 4N (P)', '5C').shows.keycards).toEqual([0, 3])
  })

  it('has every section the card promises, for both systems', () => {
    for (const system of ['tku', 'gib'] as const) {
      expect(cards[system].sections.map((s) => s.id)).toEqual([...CARD_SECTIONS])
      for (const section of cards[system].sections) expect(section.groups.length, `${system} ${section.id}`).toBeGreaterThan(0)
      // Stayman and transfers, negative doubles, Lebensohl, takeout doubles and Michaels
      expect(callOn(cards[system], 'notrump', '1N (P)', '2C').shows.name).toBe('stayman')
      expect(callOn(cards[system], 'notrump', '1N (P)', '2D').shows.name === 'transfer' || system === 'tku').toBe(true)
      expect(callOn(cards[system], 'competitive', '1H (2C)', 'X').shows.name).toBe('negative')
      expect(callOn(cards[system], 'competitive', '1N (2H)', '2N').shows.name).toBe('lebensohl')
      expect(callOn(cards[system], 'competitive', '(1H)', 'X').shows.name).toBe('takeout')
      expect(callOn(cards[system], 'competitive', '(1H)', '2H').shows.name).toBe('michaels')
    }
  })

  it('reads differently in third and fourth seat only where the rules do', () => {
    expect(callOn(cards.tku, 'openings', '', '1S', 3).shows.hcp).toEqual([10, 21])
    expect(callOn(cards.gib, 'openings', '', '1S', 4).shows.hcp).toEqual([10, 21])
    expect(groupOf(cards.tku, 'openings', '', 3).calls.some((c) => c.call === '1N')).toBe(false)
  })

  it('says what changes when vulnerable, as the rules do', () => {
    const michaels = callOn(cards.tku, 'competitive', '(1H)', '2H')
    expect(michaels.shows.hcp).toEqual([6, 15])
    expect(michaels.vulnerable?.hcp).toEqual([8, 15])
  })

  it('marks what TKB only reads', () => {
    expect(callOn(cards.tku, 'twoLevel', '2C (P)', '2S').readOnly).toBe(true)
    expect(callOn(cards.tku, 'twoLevel', '2C (P)', '2H').readOnly).toBeUndefined()
    expect(callOn(cards.gib, 'notrump', '1N (P)', '4C').readOnly).toBe(true)
  })

  it('leaves out the general rules, so a card is a system and not every possible contract', () => {
    expect(groupOf(cards.gib, 'oneLevel', '1H (P)').calls.map((c) => c.call)).not.toContain('6S')
    expect(groupOf(cards.tku, 'competitive', '(1H) X (P)').calls.map((c) => c.call)).not.toContain('5N')
  })

  it('names the handbook articles the rules follow, only for the club’s system', () => {
    const slam = cards.tku.sections.find((s) => s.id === 'slam')!
    expect(slam.articles.map((a) => a.slug)).toContain('jacoby-2nt')
    const notrump = cards.tku.sections.find((s) => s.id === 'notrump')!
    expect(notrump.articles.map((a) => a.slug)).toContain('notrump-responses')
    for (const section of cards.gib.sections) expect(section.articles).toEqual([])
  })

  it('follows a change in the system file: nothing on the card is copied by hand', () => {
    const openings = TKU.books.findIndex((b) => b.after === '')
    const book = TKU.books[openings]
    const changed: Book = {
      ...book,
      rules: book.rules.map((r) => (r.call === '1N' ? { ...r, shows: { hcp: [12, 14], balanced: true } } : r)),
    }
    const weakNotrump: System = { ...TKU, books: TKU.books.map((b, i) => (i === openings ? changed : b)) }
    expect(callOn(deriveCard(weakNotrump), 'openings', '', '1N').shows.hcp).toEqual([12, 14])
  })

  it('every row has words, in all six languages', () => {
    for (const system of ['tku', 'gib'] as const)
      for (const section of cards[system].sections)
        for (const g of section.groups)
          for (const row of g.calls) for (const lang of LANGS) expect(words(row.shows, lang), `${system} ${g.after} ${row.call}`).not.toBe('')
  })
})

group('the card agrees with what TKB actually bids', () => {
  /**
   * The cases the rules choose outside what the call announces, on purpose and documented: a good
   * 11 (Rule of 20, e5-t41) that opens as a 12-point hand. For the club's system this is a known
   * exception the president confirmed on 2026-11-06 (ROBOT.md §2): the explanation stays 12–21. In
   * 2/1 the points agree (11–21) but the total points can fall outside the 12–22 announced
   */
  const known = (system: 'tku' | 'gib', call: Call, spec: Spec): Spec => {
    if (system === 'tku' && /^1[CDHS]$/.test(call)) return { ...spec, hcp: [11, 21] }
    if (system === 'gib' && /^1[CDHS]$/.test(call)) return { ...spec, tp: undefined, hcp: [11, 21] }
    return spec
  }

  it.each(['tku', 'gib'] as const)('%s: 1,500 hands open as the card says', (system) => {
    const engine = system === 'tku' ? TKU : GIB
    const random = SEEDED(system === 'tku' ? 52 : 25)
    let checked = 0
    for (let i = 0; i < 375; i++) {
      const hands = deal(random)
      for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) {
        const { call } = choose(engine, hands[seat], seat, [], seat)
        if (call === 'P') continue
        const row = callOn(cards[system], 'openings', '', call)
        const hand = evaluate(hands[seat])
        expect(fits(hand, known(system, call, row.shows)), `${system} ${call}: ${hands[seat].join(' ')}`).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300)
  })
})

group('leads and signals come from the code that plays', () => {
  const rank = (r: string) => rankValue(r)

  it('leads the card shows are the club’s 01-fourth', () => {
    const lead = Object.fromEntries(cards.tku.leads.map((l) => [l.holding, l]))
    expect(lead.AK52).toMatchObject({ suit: 'K', notrump: '2' })
    expect(lead.AKQ2).toMatchObject({ suit: 'K', notrump: 'K' })
    expect(lead.A852).toMatchObject({ suit: 'A', notrump: '2' })
    expect(lead.KQT2).toMatchObject({ suit: 'Q', notrump: 'Q' })
    expect(lead.K852).toMatchObject({ suit: '2', notrump: '2' })
    expect(lead['9752']).toMatchObject({ suit: '7', notrump: '7' })
    expect(cards.tku.leads).toHaveLength(LEAD_HOLDINGS.length)
  })

  it('every signal row does what its words say', () => {
    const row = Object.fromEntries(cards.tku.signals.map((s) => [s.id, s]))
    expect(Object.keys(row).sort()).toEqual([...SIGNAL_IDS].sort())
    const lowest = (h: string) => [...h].at(-1)
    for (const id of ['attitudeLike', 'countAfterKingOdd', 'countOdd', 'smithLike', 'discardTransferLow'] as const) {
      expect(row[id].plays, id).toBe(lowest(row[id].holding))
    }
    for (const id of ['attitudeDislike', 'countAfterKingEven', 'countEven', 'smithDislike', 'discardTransferHigh'] as const) {
      expect(rank(row[id].plays), id).toBeGreaterThan(rank(lowest(row[id].holding)!))
    }
    expect(RANKS.includes(row.discardOdd.plays)).toBe(true)
    expect(rank(row.discardOdd.plays) % 2, 'an odd card asks for the suit').toBe(1)
    expect(rank(row.discardEven.plays) % 2, 'an even card refuses it').toBe(0)
    // Played from the holding shown
    for (const s of cards.tku.signals) expect(s.holding, s.id).toContain(s.plays)
  })

  it('both systems signal the same (ROBOT.md §3.2)', () => {
    expect(cards.gib.signals).toEqual(cards.tku.signals)
    expect(cards.gib.leads).toEqual(cards.tku.leads)
  })

  it('every signal has words in every language', () => {
    for (const lang of LANGS) for (const id of SIGNAL_IDS) expect(STRINGS[lang].systemCard.signals[id]).toBeTruthy()
  })
})

group('how the 2/1 card ships', () => {
  it('the bundled module is what the rules give now', () => {
    expect(shipped).toEqual(JSON.parse(JSON.stringify(cards.gib)))
  })

  it('is data and small', () => {
    const json = JSON.stringify(shipped)
    expect(JSON.parse(json)).toEqual(shipped)
    expect(json.length).toBeLessThan(80_000)
  })

  it('holds nothing about a deal: a card is a function of the system alone', () => {
    expect(deriveCard.length).toBe(1)
    expect(deriveCard(TKU)).toEqual(deriveCard(TKU))
    for (const card of [cards.tku, cards.gib]) {
      for (const key of ['hands', 'board', 'tableId', 'dealer', 'auction']) expect(JSON.stringify(card)).not.toContain(`"${key}`)
      // Only sample holdings, never a whole hand: every holding is one suit
      for (const signal of card.signals) expect(signal.holding.length).toBeLessThanOrEqual(6)
    }
  })
})
