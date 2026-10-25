import { describe, expect, it } from 'vitest'
import { dealerOf, vulnerabilityOf } from '../../shared/board.ts'
import { SEATS, type Hands } from '../../shared/cards.ts'
import { DEAL_PRESETS } from '../../shared/deal-presets.ts'
import { dealFrom } from '../../shared/deal-source.ts'
import {
  dealSetBoard,
  dealSetProblem,
  dealSourceOf,
  decodeDealSet,
  encodeDealSet,
  makeDealSet,
  type DealSet,
} from '../../shared/deal-set.ts'
import { meetsConditions } from '../../shared/dealer.ts'

/** mulberry32: a small seeded generator with good low bits */
function seeded(seed: number) {
  return (n: number) => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n)
  }
}

const make = (count: number, seed = 1) => {
  const set = makeDealSet({ kind: 'random', count }, seeded(seed))
  if (!set) throw new Error('no deal set')
  return set
}

describe('deal set', () => {
  it('deals the boards numbered 1 to N, each a full deck', () => {
    const set = make(8)
    expect(set.boards.map((b) => b.boardNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(dealSetProblem(set)).toBeNull()
    expect(new Set(set.boards.map((b) => JSON.stringify(b.hands))).size).toBe(8)
  })

  it('is the same every time for the same random numbers, and different for others', () => {
    expect(make(6, 42)).toEqual(make(6, 42))
    expect(make(6, 42)).not.toEqual(make(6, 43))
  })

  it('deals with the CSPRNG when no random is given', () => {
    const set = makeDealSet({ kind: 'random', count: 4 })
    expect(set && dealSetProblem(set)).toBeNull()
  })

  it('refuses a count out of range: up to 32, as a team match may have (a challenge keeps to 16 itself)', () => {
    for (const count of [0, 33, 2.5]) expect(makeDealSet({ kind: 'random', count }, seeded(1))).toBeNull()
    const set = make(32)
    expect(set.boards).toHaveLength(32)
    expect(set.boards.map((b) => b.boardNo)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
    expect(dealSetProblem(set)).toBeNull()
    expect(decodeDealSet(encodeDealSet(set))).toEqual(set)
  })

  it('meets a preset on every board', () => {
    const set = makeDealSet({ kind: 'random', count: 6, preset: 'oneNotrump' }, seeded(3))!
    expect(set.boards).toHaveLength(6)
    for (const board of set.boards) expect(meetsConditions(DEAL_PRESETS.oneNotrump, board.hands)).toBe(true)
  })

  it('takes given boards with their own numbers, and refuses ones that are not deals', () => {
    const board7 = { boardNo: 7, hands: make(1).boards[0].hands }
    const set = makeDealSet({ kind: 'given', boards: [board7] })!
    expect(set.boards[0].boardNo).toBe(7)
    expect(dealSetBoard(set, 1)).toMatchObject({ boardNo: 7, dealer: dealerOf(7), vul: vulnerabilityOf(7) })

    const short: Hands = { ...board7.hands, N: board7.hands.N.slice(1) }
    expect(makeDealSet({ kind: 'given', boards: [{ boardNo: 1, hands: short }] })).toBeNull()
    const twice: Hands = { ...board7.hands, N: [...board7.hands.N.slice(1), board7.hands.S[0]] }
    expect(makeDealSet({ kind: 'given', boards: [{ boardNo: 1, hands: twice }] })).toBeNull()
    expect(makeDealSet({ kind: 'given', boards: [{ boardNo: 0, hands: board7.hands }] })).toBeNull()
    expect(makeDealSet({ kind: 'given', boards: [] })).toBeNull()
  })

  it('gives each board with the dealer and vulnerability of its number, and nothing past the end', () => {
    const set = make(5)
    expect(dealSetBoard(set, 3)).toEqual({ boardNo: 3, dealer: 'S', vul: 'EW', hands: set.boards[2].hands })
    expect(dealSetBoard(set, 6)).toBeNull()
    // A copy: changing it leaves the set alone
    dealSetBoard(set, 1)!.hands.N.pop()
    expect(set.boards[0].hands.N).toHaveLength(13)
  })

  it('is served board by board by a fixed deal source', () => {
    const set = make(4)
    const source = dealSourceOf(set)
    const never = () => {
      throw new Error('a fixed source never shuffles')
    }
    for (let n = 1; n <= 4; n++) expect(dealFrom(source, n, never)).toEqual(set.boards[n - 1].hands)
    expect(dealFrom(source, 5, never)).toBeNull()
  })

  it('round-trips through its stored form, one PBN line a board', () => {
    const set: DealSet = { boards: [...make(16).boards.slice(0, 3), { boardNo: 12, hands: make(1, 9).boards[0].hands }] }
    const text = encodeDealSet(set)
    expect(text.split('\n')).toHaveLength(4)
    expect(text.split('\n')[3]).toMatch(/^12 N:[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]* /)
    expect(decodeDealSet(text)).toEqual(set)
  })

  it('writes a known deal in PBN order', () => {
    const hands: Hands = {
      N: ['SA', 'SK', 'SQ', 'SJ', 'ST', 'S9', 'S8', 'S7', 'S6', 'S5', 'S4', 'S3', 'S2'],
      E: 'AKQJT98765432'.split('').map((r) => 'H' + r),
      S: 'AKQJT98765432'.split('').map((r) => 'D' + r),
      W: 'AKQJT98765432'.split('').map((r) => 'C' + r),
    }
    const text = encodeDealSet({ boards: [{ boardNo: 1, hands }] })
    expect(text).toBe('1 N:AKQJT98765432... .AKQJT98765432.. ..AKQJT98765432. ...AKQJT98765432')
    expect(decodeDealSet(text)!.boards[0].hands).toEqual(hands)
  })

  it('refuses stored text that is not a deal set', () => {
    const line = encodeDealSet(make(1))
    for (const bad of ['', 'nonsense', line.replace('N:', 'E:'), line.slice(0, -1), `${line}\n${line.replace(/^1/, 'x')}`])
      expect(decodeDealSet(bad)).toBeNull()
    for (const seat of SEATS) expect(make(1).boards[0].hands[seat]).toHaveLength(13)
  })
})
