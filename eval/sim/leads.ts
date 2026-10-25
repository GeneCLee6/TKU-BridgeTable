import type { Vulnerability } from '../../shared/board.ts'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, partnerOf, rankOf, rankValue, SUITS, suitOf, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { suitCards } from '../../shared/robot/hand.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import type { EvalBoard } from '../deals.ts'
import { meanAndError } from '../stats.ts'
import { auctionText, bidBoard, contractText, parseContract } from './board.ts'
import { expandEquals, pbnHand, type Solver } from './dds.ts'
import { seededRandom } from './random.ts'
import { knowledgeOf, positionOf, sampleLayouts } from './sampler.ts'
import { scoreCards } from './score.ts'

/**
 * The opening-lead study (eval/sim/README.md §4). For each board of the deal set four TKBs bid
 * it out; the opening leader's hand, the auction and the contract are then a decision point. The
 * actual deal is solved double dummy from the leader's seat, which gives the defenders' tricks
 * for every lead. Over many boards that is the Bird–Anthias method: the hidden hands of each
 * board are one random layout that fits the auction, so the average over boards is the average
 * over layouts consistent with what the leader knows. With `samples` the leader's own sampled
 * estimate (what a robot could compute at the table) is added for comparison.
 *
 * The club president's lead concepts are each a situation and two candidate leads, A (the
 * concept's lead) and B (its alternative); the study reports the tricks and contract-defeating
 * odds of A against B, and what TKB chose.
 */

export interface LeadRecord {
  board: number
  system: RobotKind
  dealer: Seat
  vul: Vulnerability
  contract: string
  declarer: Seat
  leader: Seat
  /** The leader's hand in PBN (♠.♥.♦.♣) */
  hand: string
  auction: string
  /** Suits partner showed four or more of, as the leader reads the auction, e.g. 'HD' */
  partnerSuits: string
  /** Suits the declaring side showed four or more of */
  theirSuits: string
  /** TKB's lead */
  tkb: Card
  /** The defenders' tricks with each lead, on the actual deal */
  dd: Record<Card, number>
  /** The leader's single-dummy estimate from sampled layouts, when asked for */
  sampled?: {
    n: number
    attempts: number
    relaxed: number
    /** Average defenders' tricks with each lead */
    tricks: Record<Card, number>
    /** How often the lead defeats the contract, 0 to 1 */
    defeat: Record<Card, number>
  }
}

export interface LeadOptions {
  /** Layouts the leader samples; 0 for the actual-deal result only */
  samples: number
  /** The seed the samples are drawn from (with the board number) */
  seed: string
}

/** The board's lead decision solved, or null when the board was passed out */
export async function leadRecord(board: EvalBoard, kind: RobotKind, solver: Solver, options: LeadOptions): Promise<LeadRecord | null> {
  const state = await bidBoard(board, kind)
  const contract = state.contract
  if (!contract) return null
  const leader = nextSeat(contract.declarer)
  const trump = contract.strain === 'N' ? null : contract.strain
  const tkb = await ruleBrain.play(kind, state, leader)
  const dd = Object.fromEntries(expandEquals(solver.solve({ trump, leader, trick: [], hands: state.hands })))
  const reading = new TableReading(state, leader, kind)
  const shown = (seats: Seat[]) => SUITS.filter((suit) => seats.some((s) => reading.bid(s, suit))).join('')
  const record: LeadRecord = {
    board: board.boardNo,
    system: kind,
    dealer: state.dealer,
    vul: state.vul,
    contract: contractText(contract),
    declarer: contract.declarer,
    leader,
    hand: pbnHand(state.hands[leader]),
    auction: auctionText(state),
    partnerSuits: shown([partnerOf(leader)]),
    theirSuits: shown([contract.declarer, partnerOf(contract.declarer)]),
    tkb,
    dd,
  }
  if (options.samples > 0) {
    const knowledge = knowledgeOf(state, leader, kind)
    const sampling = sampleLayouts(knowledge.problem, options.samples, seededRandom(`${options.seed}:${board.boardNo}:lead`))
    const layouts = sampling.layouts.map((layout) => expandEquals(solver.solve(positionOf(knowledge, layout))))
    const scores = scoreCards(layouts, { contract, declaring: false, vulnerable: isVulnerable(state.vul, contract.declarer), won: 0 })
    record.sampled = {
      n: sampling.layouts.length,
      attempts: sampling.attempts,
      relaxed: sampling.relaxed,
      tricks: Object.fromEntries(scores.map((s) => [s.card, s.meanTricks])),
      defeat: Object.fromEntries(scores.map((s) => [s.card, s.pSuccess])),
    }
  }
  return record
}

/** The leader's cards from a record's PBN hand */
export function handOf(record: LeadRecord): Card[] {
  return record.hand.split('.').flatMap((ranks, i) => [...ranks].map((r) => SUITS[i] + r))
}

const isHonour = (card: Card) => 'AKQJ'.includes(rankOf(card))
const top = (cards: Card[]) => cards[0]

/** AK at the top, or two touching cards headed by the ten or better (KQ, QJ, JT, T9) */
export function hasSequence(cards: Card[]): boolean {
  if (cards.length < 2) return false
  const [a, b] = cards.map((c) => rankValue(rankOf(c)))
  return a - b === 1 && b >= 10
}

/**
 * The card the club leads from a holding: a singleton; the top of a doubleton; the ace from AK;
 * the top of a sequence; fourth best from four or more with an honour, the lowest from three with
 * an honour; the top of three small, fourth best from four or more small (ROBOT.md §3)
 */
export function conventionalLead(cards: Card[]): Card {
  if (cards.length <= 2) return top(cards)
  if (hasSequence(cards)) return top(cards)
  if (cards.some(isHonour)) return cards.length >= 4 ? cards[3] : cards.at(-1)!
  return cards.length >= 4 ? cards[3] : top(cards)
}

/** What kind of lead a card is, for the report */
export type LeadType = 'partner' | 'trump' | 'singleton' | 'doubleton' | 'aceKing' | 'sequence' | 'ace' | 'fromHonour' | 'topOfNothing' | 'smallFromNothing' | 'other'

export const LEAD_TYPE_LABEL: Record<LeadType, string> = {
  partner: '同伴的花色',
  trump: '王牌',
  singleton: '單張',
  doubleton: '雙張',
  aceKing: 'AK',
  sequence: '連張頂張',
  ace: 'A（不是 AK）',
  fromHonour: '大牌底下的小牌',
  topOfNothing: '小牌的頂張',
  smallFromNothing: '沒大牌的小牌',
  other: '其他',
}

export function leadType(hand: Card[], card: Card, trump: Suit | null, partnerSuits: string): LeadType {
  const suit = suitOf(card)
  const cards = suitCards(hand, suit)
  if (partnerSuits.includes(suit)) return 'partner'
  if (suit === trump) return 'trump'
  if (cards.length === 1) return 'singleton'
  if (cards.length === 2) return 'doubleton'
  const ak = rankOf(cards[0]) === 'A' && rankOf(cards[1]) === 'K'
  if (ak) return 'AK'.includes(rankOf(card)) ? 'aceKing' : 'other'
  if (hasSequence(cards)) return card === cards[0] ? 'sequence' : 'other'
  if (rankOf(card) === 'A') return 'ace'
  if (cards.some(isHonour)) return card === cards[0] ? 'other' : 'fromHonour'
  return card === cards[0] ? 'topOfNothing' : 'smallFromNothing'
}

/** One of the president's concepts: when it applies, the concept's lead A and the alternative B */
export interface ConceptCase {
  concept: string
  /** A finer split of the situation, such as 'NT' or '單張' */
  split: string
  a: Card
  b: Card
}

export interface ConceptDefinition {
  id: string
  label: string
  /** The concept's lead A against its alternative B */
  question: string
  cases(record: LeadRecord, hand: Card[], trump: Suit | null): ConceptCase[]
}

const longest = (hand: Card[], suits: Suit[], min: number): Suit | undefined =>
  suits
    .filter((s) => suitCards(hand, s).length >= min)
    .sort((a, b) => suitCards(hand, b).length - suitCards(hand, a).length || SUITS.indexOf(a) - SUITS.indexOf(b))[0]

export const CONCEPTS: ConceptDefinition[] = [
  {
    id: 'ntPartnerVsOwn',
    label: '無王：攻同伴叫過的花色，還是自己的長門',
    question: 'A 攻同伴的花色，B 攻自己最長的花色（4 張以上）',
    cases(record, hand, trump) {
      if (trump) return []
      const partnerSuits = [...record.partnerSuits] as Suit[]
      const p = partnerSuits.filter((s) => suitCards(hand, s).length).sort((a, b) => suitCards(hand, b).length - suitCards(hand, a).length)[0]
      if (!p) return []
      const own = longest(hand, SUITS.filter((s) => !partnerSuits.includes(s)), 4)
      if (!own) return []
      const held = suitCards(hand, p).length
      return [{ concept: this.id, split: `同伴花色 ${held >= 3 ? '3 張以上' : `${held} 張`}`, a: conventionalLead(suitCards(hand, p)), b: conventionalLead(suitCards(hand, own)) }]
    },
  },
  {
    id: 'sequenceVsAway',
    label: '連張頂張，還是從大牌底下攻出',
    question: 'A 攻連張的頂張，B 從另一門有大牌但不連的花色攻小牌',
    cases(record, hand, trump) {
      const side = SUITS.filter((s) => s !== trump && !record.partnerSuits.includes(s))
      const seq = side.filter((s) => suitCards(hand, s).length >= 3 && hasSequence(suitCards(hand, s)))
      const away = side.filter((s) => {
        const cards = suitCards(hand, s)
        return cards.length >= 3 && cards.some(isHonour) && !hasSequence(cards)
      })
      if (!seq.length || !away.length) return []
      const a = longest(hand, seq, 3)!
      const b = longest(hand, away, 3)!
      return [{ concept: this.id, split: trump ? '王牌合約' : '無王', a: conventionalLead(suitCards(hand, a)), b: conventionalLead(suitCards(hand, b)) }]
    },
  },
  {
    id: 'trumpLead',
    label: '攻王牌',
    question: 'A 攻最小的王牌，B 攻最長旁門的慣例牌',
    cases(record, hand, trump) {
      if (!trump) return []
      const trumps = suitCards(hand, trump)
      if (trumps.length < 2) return []
      const side = longest(hand, SUITS.filter((s) => s !== trump), 3)
      if (!side) return []
      const twoSuits = record.theirSuits.replace(trump, '').length >= 1
      const honour = trumps.some((c) => 'AKQ'.includes(rankOf(c)))
      return [{ concept: this.id, split: `${twoSuits ? '敵方叫過旁門' : '敵方只叫王牌'}・${honour ? '王牌有 A/K/Q' : '王牌小牌'}`, a: trumps.at(-1)!, b: conventionalLead(suitCards(hand, side)) }]
    },
  },
  {
    id: 'shortSuit',
    label: '王牌合約：攻短門（單張、小雙張）',
    question: 'A 攻單張或小雙張的頂張，B 攻最長旁門的慣例牌',
    cases(record, hand, trump) {
      if (!trump || !suitCards(hand, trump).length) return []
      const trumps = suitCards(hand, trump)
      const shorts = SUITS.filter((s) => {
        if (s === trump || record.partnerSuits.includes(s)) return false
        const cards = suitCards(hand, s)
        return cards.length === 1 || (cards.length === 2 && cards.every((c) => !isHonour(c)))
      })
      if (!shorts.length) return []
      const short = shorts.sort((x, y) => suitCards(hand, x).length - suitCards(hand, y).length)[0]
      const long = longest(hand, SUITS.filter((s) => s !== trump && s !== short), 3)
      if (!long) return []
      const control = trumps.length >= 4 || rankOf(trumps[0]) === 'A'
      const held = suitCards(hand, short)
      return [{ concept: this.id, split: `${held.length === 1 ? '單張' : '小雙張'}・${control ? '有王牌控制' : '沒有王牌控制'}`, a: top(held), b: conventionalLead(suitCards(hand, long)) }]
    },
  },
]

/** Tricks the defenders need to defeat the contract */
export const defeatNeeds = (record: LeadRecord) => 8 - Number(record.contract[0])

export interface ConceptStats {
  concept: string
  split: string
  n: number
  /** Tricks A takes over B, on the actual deals, with its standard error */
  trickGain: number
  trickGainError: number
  /** How often A and B defeat the contract */
  defeatA: number
  defeatB: number
  /** How often A is the (or a) best lead, and B */
  aBest: number
  bBest: number
  /** What TKB led in these situations */
  tkbA: number
  tkbB: number
  tkbOther: number
  /** TKB's average tricks lost against the best lead here */
  tkbLoss: number
  /** The same from the leader's sampled estimate, when the records have one */
  sampledTrickGain?: number
  sampledDefeatA?: number
  sampledDefeatB?: number
}

export interface TypeStats {
  type: LeadType
  n: number
  /** Average tricks lost against the best lead */
  loss: number
  /** How often the lead was (a) best */
  best: number
  /** How often the best lead defeats the contract and this one does not */
  costContract: number
}

export interface Disagreement {
  contract: 'NT' | 'suit'
  tkb: LeadType
  best: LeadType
  n: number
  loss: number
}

export interface LeadStudy {
  boards: number
  notrump: number
  suit: number
  sampled: number
  /** The sampler's acceptance rate and relaxed share over the sampled records */
  acceptance?: number
  relaxed?: number
  concepts: ConceptStats[]
  /** TKB's leads by type, notrump and suit contracts */
  types: { notrump: TypeStats[]; suit: TypeStats[] }
  /** Where TKB's lead type differs from the best lead's, by total tricks lost */
  disagreements: Disagreement[]
  /** TKB's overall loss against the best lead */
  tkbLoss: { notrump: number; suit: number }
  /** How often TKB's lead is a best lead */
  tkbBest: { notrump: number; suit: number }
  /** How often the sampled best lead is also best on the actual deal (sampled records only) */
  sampledAgrees?: number
}

const bestTricks = (record: LeadRecord) => Math.max(...Object.values(record.dd))

interface ConceptTotals {
  def: ConceptDefinition
  split: string
  gains: number[]
  defeatA: number
  defeatB: number
  aBest: number
  bBest: number
  tkbA: number
  tkbB: number
  tkbOther: number
  loss: number
  sGains: number[]
  sDefeatA: number
  sDefeatB: number
}

interface TypeTotals {
  n: number
  loss: number
  best: number
  costContract: number
}

/** Adds up the study one record at a time, so a million records never need to be in memory at once */
export class LeadStudyBuilder {
  private readonly byConcept = new Map<string, ConceptTotals>()
  private readonly byType = { notrump: new Map<LeadType, TypeTotals>(), suit: new Map<LeadType, TypeTotals>() }
  private readonly disagreements = new Map<string, Disagreement>()
  private readonly totals = { notrump: { n: 0, loss: 0, best: 0 }, suit: { n: 0, loss: 0, best: 0 } }
  private boards = 0
  private sampled = 0
  private sampledLayouts = 0
  private attempts = 0
  private relaxed = 0
  private sampledAgrees = 0

  add(record: LeadRecord) {
    const { byConcept, byType, disagreements, totals } = this
    this.boards++
    const hand = handOf(record)
    const trump = record.contract[1] === 'N' ? null : (record.contract[1] as Suit)
    const kind = trump ? 'suit' : 'notrump'
    const best = bestTricks(record)
    const need = defeatNeeds(record)
    const loss = best - record.dd[record.tkb]
    totals[kind].n++
    totals[kind].loss += loss
    if (loss === 0) totals[kind].best++

    const type = leadType(hand, record.tkb, trump, record.partnerSuits)
    const stats = byType[kind].get(type) ?? { n: 0, loss: 0, best: 0, costContract: 0 }
    stats.n++
    stats.loss += loss
    if (loss === 0) stats.best++
    if (best >= need && record.dd[record.tkb] < need) stats.costContract++
    byType[kind].set(type, stats)

    if (loss > 0) {
      const bestCard = Object.entries(record.dd).sort((a, b) => b[1] - a[1] || rankValue(rankOf(b[0])) - rankValue(rankOf(a[0])))[0][0]
      const bestType = leadType(hand, bestCard, trump, record.partnerSuits)
      const key = `${kind}:${type}:${bestType}`
      const d = disagreements.get(key) ?? { contract: kind === 'notrump' ? 'NT' : 'suit', tkb: type, best: bestType, n: 0, loss: 0 }
      d.n++
      d.loss += loss
      disagreements.set(key, d)
    }

    if (record.sampled) {
      this.sampled++
      this.sampledLayouts += record.sampled.n
      this.attempts += record.sampled.attempts
      this.relaxed += record.sampled.relaxed
      const sampledBest = Object.entries(record.sampled.tricks).sort((a, b) => b[1] - a[1])[0][0]
      if (record.dd[sampledBest] === best) this.sampledAgrees++
    }

    for (const def of CONCEPTS) {
      for (const c of def.cases(record, hand, trump)) {
        const key = `${c.concept}|${c.split}`
        const entry = byConcept.get(key) ?? { def, split: c.split, gains: [], defeatA: 0, defeatB: 0, aBest: 0, bBest: 0, tkbA: 0, tkbB: 0, tkbOther: 0, loss: 0, sGains: [], sDefeatA: 0, sDefeatB: 0 }
        const a = record.dd[c.a]
        const b = record.dd[c.b]
        entry.gains.push(a - b)
        if (a >= need) entry.defeatA++
        if (b >= need) entry.defeatB++
        if (a === best) entry.aBest++
        if (b === best) entry.bBest++
        if (record.tkb === c.a) entry.tkbA++
        else if (record.tkb === c.b) entry.tkbB++
        else entry.tkbOther++
        entry.loss += loss
        if (record.sampled) {
          entry.sGains.push(record.sampled.tricks[c.a] - record.sampled.tricks[c.b])
          entry.sDefeatA += record.sampled.defeat[c.a]
          entry.sDefeatB += record.sampled.defeat[c.b]
        }
        byConcept.set(key, entry)
      }
    }
  }

  build(): LeadStudy {
    const { byConcept, byType, disagreements, totals, sampled, sampledLayouts, attempts, relaxed, sampledAgrees } = this
    const concepts: ConceptStats[] = [...byConcept.values()]
    .sort((x, y) => CONCEPTS.indexOf(x.def) - CONCEPTS.indexOf(y.def) || x.split.localeCompare(y.split))
    .map((e) => {
      const n = e.gains.length
      const { mean, standardError } = meanAndError(e.gains)
      const stats: ConceptStats = {
        concept: e.def.id,
        split: e.split,
        n,
        trickGain: mean,
        trickGainError: standardError,
        defeatA: e.defeatA / n,
        defeatB: e.defeatB / n,
        aBest: e.aBest / n,
        bBest: e.bBest / n,
        tkbA: e.tkbA,
        tkbB: e.tkbB,
        tkbOther: e.tkbOther,
        tkbLoss: e.loss / n,
      }
      if (e.sGains.length) {
        stats.sampledTrickGain = meanAndError(e.sGains).mean
        stats.sampledDefeatA = e.sDefeatA / e.sGains.length
        stats.sampledDefeatB = e.sDefeatB / e.sGains.length
      }
      return stats
    })

    const typeStats = (map: Map<LeadType, TypeTotals>): TypeStats[] =>
      [...map].map(([type, s]) => ({ type, n: s.n, loss: s.loss / s.n, best: s.best / s.n, costContract: s.costContract / s.n })).sort((a, b) => b.n - a.n)

    const study: LeadStudy = {
      boards: this.boards,
      notrump: totals.notrump.n,
      suit: totals.suit.n,
      sampled,
      concepts,
      types: { notrump: typeStats(byType.notrump), suit: typeStats(byType.suit) },
      disagreements: [...disagreements.values()].sort((a, b) => b.loss - a.loss).slice(0, 12),
      tkbLoss: { notrump: totals.notrump.n ? totals.notrump.loss / totals.notrump.n : 0, suit: totals.suit.n ? totals.suit.loss / totals.suit.n : 0 },
      tkbBest: { notrump: totals.notrump.n ? totals.notrump.best / totals.notrump.n : 0, suit: totals.suit.n ? totals.suit.best / totals.suit.n : 0 },
    }
    if (sampled) {
      study.acceptance = attempts ? sampledLayouts / attempts : 0
      study.relaxed = sampledLayouts ? relaxed / sampledLayouts : 0
      study.sampledAgrees = sampledAgrees / sampled
    }
    return study
  }
}

export function leadStudy(records: Iterable<LeadRecord>): LeadStudy {
  const builder = new LeadStudyBuilder()
  for (const record of records) builder.add(record)
  return builder.build()
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const signed = (x: number, digits = 3) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits)

/** The study as a Markdown report in Traditional Chinese */
export function leadReport(study: LeadStudy, heading: string): string {
  const lines: string[] = [
    `## 首攻研究：${heading}`,
    '',
    `${study.boards} 副（無王 ${study.notrump}、王牌合約 ${study.suit}）。每副由四個 TKB 叫完，首攻者的每一張牌都用實際牌局的雙明手分析算出防家拿幾墩；「損失」是跟最好的首攻比少拿幾墩。`,
    '',
    '### TKB 的首攻跟雙明手最佳的差距',
    '',
    '| 合約 | 副數 | 平均損失（墩） | 首攻就是最佳的比例 |',
    '| --- | --- | --- | --- |',
    `| 無王 | ${study.notrump} | ${study.tkbLoss.notrump.toFixed(3)} | ${pct(study.tkbBest.notrump)} |`,
    `| 王牌 | ${study.suit} | ${study.tkbLoss.suit.toFixed(3)} | ${pct(study.tkbBest.suit)} |`,
    '',
  ]
  if (study.sampled) {
    lines.push(
      `單明手抽樣：${study.sampled} 副有首攻者自己的抽樣估計；抽樣接受率 ${pct(study.acceptance ?? 0)}，放寬條件才抽到的佔 ${pct(study.relaxed ?? 0)}；抽樣選出的首攻在實際牌局也是最佳的比例 ${pct(study.sampledAgrees ?? 0)}。`,
      '',
    )
  }
  lines.push('### 社長的首攻觀念', '', '每個觀念是一個情境加上兩張候選牌：A 是觀念說的首攻，B 是另一種選擇。「A − B」是 A 比 B 多拿的墩數（± 標準誤），「倒合約」是那張首攻在雙明手下能倒合約的比例，「最佳」是那張牌就是（或並列）最好首攻的比例；TKB 欄是 TKB 在這些情境實際攻了 A、B 或別的牌幾次，以及它平均損失幾墩。', '')
  for (const def of CONCEPTS) {
    const rows = study.concepts.filter((c) => c.concept === def.id)
    lines.push(`#### ${def.label}`, '', def.question, '')
    if (!rows.length) {
      lines.push('（這組牌沒有這種情境）', '')
      continue
    }
    const sampled = rows.some((r) => r.sampledTrickGain !== undefined)
    lines.push(
      `| 情境 | 副數 | A − B（墩） | 倒合約 A | 倒合約 B | 最佳 A | 最佳 B | TKB 攻 A／B／其他 | TKB 損失 |${sampled ? ' 抽樣 A − B | 抽樣倒合約 A／B |' : ''}`,
      `| --- | --- | --- | --- | --- | --- | --- | --- | --- |${sampled ? ' --- | --- |' : ''}`,
    )
    for (const r of rows) {
      const extra = sampled && r.sampledTrickGain !== undefined ? ` ${signed(r.sampledTrickGain)} | ${pct(r.sampledDefeatA ?? 0)}／${pct(r.sampledDefeatB ?? 0)} |` : sampled ? ' — | — |' : ''
      lines.push(
        `| ${r.split} | ${r.n} | ${signed(r.trickGain)} ± ${r.trickGainError.toFixed(3)} | ${pct(r.defeatA)} | ${pct(r.defeatB)} | ${pct(r.aBest)} | ${pct(r.bBest)} | ${r.tkbA}／${r.tkbB}／${r.tkbOther} | ${r.tkbLoss.toFixed(3)} |${extra}`,
      )
    }
    lines.push('')
  }
  lines.push('### TKB 各種首攻的損失', '')
  for (const [kind, label] of [['notrump', '無王'], ['suit', '王牌合約']] as const) {
    lines.push(`#### ${label}`, '', '| TKB 的首攻 | 副數 | 平均損失（墩） | 就是最佳 | 最佳能倒、這張不能 |', '| --- | --- | --- | --- | --- |')
    for (const t of study.types[kind]) lines.push(`| ${LEAD_TYPE_LABEL[t.type]} | ${t.n} | ${t.loss.toFixed(3)} | ${pct(t.best)} | ${pct(t.costContract)} |`)
    lines.push('')
  }
  lines.push('### TKB 跟雙明手最佳首攻不同的情況（依總損失排序）', '', '| 合約 | TKB 攻 | 最佳是 | 副數 | 平均損失（墩） | 總損失 |', '| --- | --- | --- | --- | --- | --- |')
  for (const d of study.disagreements)
    lines.push(`| ${d.contract === 'NT' ? '無王' : '王牌'} | ${LEAD_TYPE_LABEL[d.tkb]} | ${LEAD_TYPE_LABEL[d.best]} | ${d.n} | ${(d.loss / d.n).toFixed(3)} | ${d.loss} |`)
  lines.push('')
  return lines.join('\n')
}

/** The record's contract as a Contract (for scoring) */
export const recordContract = (record: LeadRecord) => parseContract(record.contract, record.declarer)
