import { partnerOf, rankOf, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import { legalCards, playCard, remainingCards, tricksOf, turnOf, type BoardState, type PlayedCard } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { runningSuitAt } from '../../shared/robot/defence-reading.ts'
import { suitCards } from '../../shared/robot/hand.ts'
import { readDiscard } from '../../shared/robot/play.ts'
import { byRank, honours, value, View } from '../../shared/robot/view.ts'
import type { EvalBoard } from '../deals.ts'
import { bidBoard, contractText } from './board.ts'
import { expandEquals, type Solver } from './dds.ts'
import { seededRandom } from './random.ts'
import { knowledgeOf, positionOf, sampleLayouts } from './sampler.ts'

/**
 * Where TKB's card breaks common sense and double dummy cannot tell (e6-t28, eval/sim/README.md
 * §3.12). Four TKBs play a board out. At each decision, `commonSenseFlags` looks only at what the
 * seat can see and at the card TKB chose, and names a textbook alternative when the card looks
 * wrong: second hand high, third hand not high, an honour wasted, equals played out of order, a
 * signal the club's carding reads differently, a winner discarded. The flagged positions alone are
 * then solved, on the real layout and on layouts sampled from the seat's knowledge, to see whether
 * the alternative was equal, better or worse. A flag where the alternative is worse is a rule
 * doing its job; only the equal ones are what the task asks about.
 */

export type Category =
  | 'secondHigh'
  | 'thirdLow'
  | 'thirdShort'
  | 'wasteHonour'
  | 'wasteRuff'
  | 'equalsFollow'
  | 'equalsLead'
  | 'signalFollow'
  | 'signalDiscard'
  | 'discardWinner'

export const CATEGORY_LABEL: Record<Category, string> = {
  secondHigh: '第二家無故出大牌',
  thirdLow: '第三家贏得了卻不出大',
  thirdShort: '第三家沒出到最大（防家）',
  wasteHonour: '浪費大牌：較小的牌做得到一樣的事',
  wasteRuff: '王吃或墊王牌浪費',
  equalsFollow: '防家跟牌沒出相連牌的最小張',
  equalsLead: '防家領出沒攻連張頂張',
  signalFollow: '跟牌信號與社團打法相反',
  signalDiscard: '第一次墊牌的信號與自己的牌相反',
  discardWinner: '有輸張卻墊贏張',
}

export interface Flag {
  category: Category
  /** Which form of the category: `cover`, `win`, `under`… */
  sub: string
  /** The textbook card */
  alt: Card
}

function winning(trick: readonly PlayedCard[], trump: Suit | null): PlayedCard {
  let best = trick[0]
  for (const played of trick.slice(1)) {
    const same = suitOf(played.card) === suitOf(best.card)
    if (same ? value(played.card) > value(best.card) : suitOf(played.card) === trump && suitOf(best.card) !== trump) best = played
  }
  return best
}

/** Whether this seat has discarded before on this board: only the first discard is read */
function discardedBefore(state: BoardState, seat: Seat, trump: Suit | null): boolean {
  return tricksOf(state).some((t) => {
    const mine = t.cards.find((p) => p.seat === seat)
    return !!mine && suitOf(mine.card) !== suitOf(t.cards[0].card) && suitOf(mine.card) !== trump
  })
}

/** The carding of ROBOT.md §3's table, written out again here so the check is not the code it checks */
function expectedSignal(view: View, trick: readonly PlayedCard[], cards: readonly Card[], trump: Suit | null): 'low' | 'high' | null {
  const { state, seat } = view
  const leader = trick[0]
  const led = suitOf(leader.card)
  if (leader.seat === partnerOf(seat)) {
    if (rankOf(leader.card) === 'K') return cards.length % 2 === 0 ? 'high' : 'low'
    const like = cards.some((c) => (rankOf(leader.card) === 'Q' ? 'AKJ' : 'AKQ').includes(rankOf(c)))
    return like ? 'low' : 'high'
  }
  // Suit preference on dummy's running suit (T4) decides by other suits: not a matter of count
  if (trump && runningSuitAt(view, state.play.length - trick.length, trump) === led) return null
  const tricks = tricksOf(state)
  const first = tricks.slice(1).find((t) => sameSide(t.leader, state.contract!.declarer))
  // Smith Echo: first suit the declarer plays in notrump, about the opening lead
  if (!trump && first && first === tricks.at(-1) && suitOf(state.play[0].card) !== led) return null
  return cards.length % 2 === 0 ? 'high' : 'low'
}

/** Every way TKB's card looks wrong from what the seat can see; empty when it looks fine */
export function commonSenseFlags(state: BoardState, seat: Seat, card: Card, kind: RobotKind): Flag[] {
  const legal = legalCards(state, seat)
  if (legal.length < 2 || state.play.length === 0) return []
  const contract = state.contract!
  const trump: Suit | null = contract.strain === 'N' ? null : contract.strain
  const defending = !sameSide(seat, contract.declarer)
  const view = new View(state, seat, kind)
  const current = tricksOf(state).at(-1)
  const trick = current && !current.winner ? current.cards : []
  const flags: Flag[] = []
  const flag = (category: Category, sub: string, alt: Card) => flags.push({ category, sub, alt })

  if (trick.length === 0) {
    if (defending) {
      const cards = suitCards(legal, suitOf(card))
      if (cards.length >= 2 && value(cards[0]) >= 10 && view.lowestEqual(cards[0], cards) !== cards[0] && card !== cards[0]) {
        flag('equalsLead', view.lowestEqual(cards[0], cards) === view.lowestEqual(card, cards) ? 'inside' : 'below', cards[0])
      }
    }
    return flags
  }

  const led = suitOf(trick[0].card)
  const following = legal.filter((c) => suitOf(c) === led)
  const best = winning(trick, trump)
  const partnerWinning = best.seat === partnerOf(seat)
  const beats = (c: Card) => suitOf(best.card) === led && suitOf(c) === led && value(c) > value(best.card)

  if (following.length) {
    const sorted = [...following].sort(byRank)
    const low = sorted[0]
    const top = sorted.at(-1)!
    const equalLow = view.lowestEqual(card, following)
    const dummy = partnerOf(contract.declarer)
    const dummyLast = trick.length === 2 && defending && !trick.some((p) => p.seat === dummy) && trick[0].seat !== dummy
    const dummyLeft = dummyLast ? suitCards(view.dummyCards(), led) : []
    const hiddenAbove = (c: Card) => view.unseenAbove(c).length

    if (trick.length === 1) {
      if (value(card) >= 10 && equalLow !== view.lowestEqual(low, following) && card !== low) {
        const lead = trick[0].card
        const sub = value(card) < value(lead) ? 'under' : value(lead) >= 11 ? 'cover' : view.winsNow(card) ? 'winMaster' : 'winCheap'
        flag('secondHigh', sub, low)
      }
    } else if (trick.length === 2) {
      const beaters = sorted.filter(beats)
      if (beaters.length && !beats(card)) {
        const partnerSafe = partnerWinning && (value(best.card) >= 11 || view.higherOut(best.card).length === 0 || (dummyLast && !dummyLeft.some((c) => value(c) > value(best.card))))
        const over = dummyLeft.length ? beaters.filter((c) => value(c) > value(dummyLeft[0])) : beaters
        if (!partnerSafe && over.length) flag('thirdLow', defending ? 'defender' : 'declaring', view.lowestEqual(top, following))
      }
      if (defending && beats(card) && !dummyLast && equalLow !== view.lowestEqual(top, following) && hiddenAbove(card) > 0) {
        flag('thirdShort', trump ? 'suit' : 'notrump', view.lowestEqual(top, following))
      }
    }

    if (trick.length >= 2 && value(card) >= 10 && card !== low && equalLow !== view.lowestEqual(low, following)) {
      const wins = beats(card)
      if (!wins) flag('wasteHonour', 'losing', low)
      else if (partnerWinning && (trick.length === 3 || (dummyLast && !dummyLeft.some((c) => value(c) > value(best.card))) || hiddenAbove(best.card) === 0)) flag('wasteHonour', 'overtake', low)
      else if (!partnerWinning && trick.length === 3) {
        const cheapest = sorted.find(beats)!
        if (view.lowestEqual(cheapest, following) !== equalLow) flag('wasteHonour', 'dearWin', cheapest)
      }
    }

    if (defending && equalLow !== card) {
      if (beats(card)) flag('equalsFollow', 'win', equalLow)
      else if (value(card) >= 10) flag('equalsFollow', 'lose', equalLow)
    }

    if (defending && following.length >= 2 && !beats(card) && !(suitOf(best.card) !== led)) {
      const expected = expectedSignal(view, trick, following, trump)
      if (expected === 'low' && card !== low) flag('signalFollow', trick[0].seat === partnerOf(seat) ? 'attitudeOrKing' : 'count', low)
      if (expected === 'high' && card === low) {
        const spot = sorted.slice(1).filter((c) => value(c) < 11).at(-1)
        flag('signalFollow', spot ? 'highMissed' : 'honourOnly', spot ?? sorted[1])
      }
    }
    return flags
  }

  const others = legal.filter((c) => suitOf(c) !== trump)
  if (suitOf(card) === trump) {
    const tableTrumps = trick.filter((p) => suitOf(p.card) === trump).map((p) => value(p.card))
    const over = legal.filter((c) => suitOf(c) === trump && value(c) > Math.max(0, ...tableTrumps)).sort(byRank)
    if (!over.includes(card) && others.length) flag('wasteRuff', 'underruff', [...others].sort(byRank)[0])
    if (over.includes(card) && card !== over[0]) {
      const equal = view.lowestEqual(card, over)
      if (equal !== view.lowestEqual(over[0], over)) flag('wasteRuff', trick.length === 3 ? 'dearLast' : 'dear', over[0])
      else if (defending) flag('equalsFollow', 'ruff', over[0])
    }
    return flags
  }

  const spare = others.filter((c) => !view.isMaster(c)).sort(byRank)
  if (view.isMaster(card) && spare.length) flag('discardWinner', defending ? 'defender' : 'declaring', spare[0])

  if (defending && trump !== suitOf(card) && !discardedBefore(state, seat, trump)) {
    const sideSuits = SUITS.filter((s) => s !== trump && s !== led)
    const strength = (s: Suit) => honours(suitCards(legal, s))
    const want = [...sideSuits].sort((a, b) => strength(b) - strength(a)).find((s) => strength(s) >= 3) ?? null
    const read = readDiscard(card, trump, led)
    const says = (c: Card) => readDiscard(c, trump, led)
    if (want && read !== want) {
      const alt = spare.find((c) => says(c) === want)
      if (alt) flag('signalDiscard', 'againstWant', alt)
    } else if (!want && read === suitOf(card)) {
      const alt = spare.find((c) => says(c) !== suitOf(c))
      if (alt) flag('signalDiscard', 'oddNoInterest', alt)
    }
  }
  return flags
}

export interface FlagRecord extends Flag {
  /** The position in the board's play (replay from the opening lead to see it) */
  at: number
  seat: Seat
  declaring: boolean
  trick: number
  card: Card
  /** Tricks the alternative gains over TKB's card on the real layout */
  actual: number
  /** The same, on average over the sampled layouts */
  mean: number
  /** Every sampled layout and the real one say the two cards are equal */
  equal: boolean
}

export interface CommonSenseRecord {
  board: number
  contract: string
  /** Decisions with a choice, opening leads apart */
  decisions: { declaring: number; defending: number }
  flags: FlagRecord[]
}

export interface CommonSenseOptions {
  samples: number
  seed: string
}

/** The board played out by four TKBs, each flagged decision solved */
export async function commonSenseBoard(board: EvalBoard, kind: RobotKind, solver: Solver, options: CommonSenseOptions): Promise<CommonSenseRecord | null> {
  let state = await bidBoard(board, kind)
  const contract = state.contract
  if (!contract) return null
  const record: CommonSenseRecord = { board: board.boardNo, contract: contractText(contract), decisions: { declaring: 0, defending: 0 }, flags: [] }
  const trump = contract.strain === 'N' ? null : contract.strain
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    const card = await ruleBrain.play(kind, state, seat)
    const declaring = sameSide(seat, contract.declarer)
    if (legalCards(state, seat).length > 1 && state.play.length) {
      record.decisions[declaring ? 'declaring' : 'defending']++
      const flags = commonSenseFlags(state, seat, card, kind)
      if (flags.length) {
        const current = tricksOf(state).at(-1)
        const open = current && !current.winner ? current : undefined
        const hands = {} as Record<Seat, Card[]>
        for (const s of SEATS) hands[s] = remainingCards(state, s)
        const knowledge = knowledgeOf(state, seat, kind)
        const real = expandEquals(solver.solve({ trump, leader: open ? open.leader : seat, trick: open ? open.cards.map((p) => p.card) : [], hands }))
        const sampling = sampleLayouts(knowledge.problem, options.samples, seededRandom(`${options.seed}:${board.boardNo}:${state.play.length}`))
        const layouts = sampling.layouts.map((layout) => expandEquals(solver.solve(positionOf(knowledge, layout))))
        for (const f of flags) {
          const delta = (tricks: Map<Card, number>) => (tricks.get(f.alt) ?? 0) - (tricks.get(card) ?? 0)
          const deltas = layouts.map(delta)
          const actual = delta(real)
          record.flags.push({
            ...f,
            at: state.play.length,
            seat,
            declaring,
            trick: Math.floor(state.play.length / 4) + 1,
            card,
            actual,
            mean: deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length),
            equal: actual === 0 && deltas.every((d) => d === 0),
          })
        }
      }
    }
    state = playCard(state, seat, card)
  }
  return record
}

export interface CategoryRow {
  category: Category
  sub: string
  declaring: boolean
  flagged: number
  /** The alternative equal on the real layout and every sampled one: the positions e6-t28 is about */
  equal: number
  /** On the sampled layouts on average, TKB's card is worse than the alternative */
  altBetter: number
  /** On the sampled layouts on average, TKB's card is better: the rule has its reason */
  altWorse: number
  /** Sum over the flags of the alternative's gain in tricks on average */
  gain: number
}

export interface CommonSenseStudy {
  boards: number
  decisions: { declaring: number; defending: number }
  rows: CategoryRow[]
}

export function commonSenseStudy(records: readonly CommonSenseRecord[]): CommonSenseStudy {
  const rows = new Map<string, CategoryRow>()
  const decisions = { declaring: 0, defending: 0 }
  for (const record of records) {
    decisions.declaring += record.decisions.declaring
    decisions.defending += record.decisions.defending
    for (const f of record.flags) {
      const key = `${f.category}/${f.sub}/${f.declaring}`
      let row = rows.get(key)
      if (!row) rows.set(key, (row = { category: f.category, sub: f.sub, declaring: f.declaring, flagged: 0, equal: 0, altBetter: 0, altWorse: 0, gain: 0 }))
      row.flagged++
      if (f.equal) row.equal++
      else if (f.mean > 0) row.altBetter++
      else if (f.mean < 0) row.altWorse++
      row.gain += f.mean
    }
  }
  return { boards: records.length, decisions, rows: [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || b.flagged - a.flagged) }
}

export function commonSenseReport(study: CommonSenseStudy, heading: string): string {
  const lines = [
    `## TKB 的常識檢查：${heading}`,
    '',
    `${study.boards} 副由四個 TKB 叫完打完；首攻之外有選擇的決策 ${study.decisions.defending} 個防家、${study.decisions.declaring} 個坐莊方。「雙明手無差別」是真實牌型與每個抽樣佈局上，書上那張牌和 TKB 的牌墩數都一樣；「書上較好」「書上較差」是其餘的看抽樣平均；「墩差」是書上那張牌在所有被標記的決策上平均多拿的墩數加總。`,
    '',
    '| 類別 | 形式 | 哪一方 | 標記 | 雙明手無差別 | 書上較好 | 書上較差 | 墩差 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of study.rows) lines.push(`| ${CATEGORY_LABEL[r.category]} | ${r.sub} | ${r.declaring ? '坐莊方' : '防家'} | ${r.flagged} | ${r.equal} | ${r.altBetter} | ${r.altWorse} | ${r.gain >= 0 ? '+' : ''}${r.gain.toFixed(1)} |`)
  lines.push('')
  return lines.join('\n')
}
