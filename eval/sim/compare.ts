import { isVulnerable } from '../../shared/board.ts'
import { partnerOf, sameSide, sideOf, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import { legalCards, playCard, tricksOf, tricksWon, turnOf } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import type { EvalBoard } from '../deals.ts'
import { bidBoard, contractText } from './board.ts'
import { expandEquals, type Solver } from './dds.ts'
import { seededRandom } from './random.ts'
import { knowledgeOf, positionOf, sampleLayouts } from './sampler.ts'
import { bestCard, objectiveValue, scoreCards, type CardScore, type Objective } from './score.ts'

/**
 * TKB against single dummy by sampling (eval/sim/README.md §3). A board is bid and played out by
 * four TKBs; at every decision with a choice, the seat's knowledge is sampled, each layout solved
 * double dummy, and the cards scored. Where TKB's card scores worse than the best, the loss is
 * kept with the situation, so the report can say where TKB loses most. Decisions where every
 * card scores the same (a signal, say: nothing double dummy can see) are skipped.
 */

export type Situation =
  | 'leadNT'
  | 'leadSuit'
  | 'defenderLead'
  | 'secondHand'
  | 'thirdHand'
  | 'fourthHand'
  | 'defenderDiscard'
  | 'declarerLead'
  | 'declarerFollow'
  | 'declarerDiscard'

export const SITUATION_LABEL: Record<Situation, string> = {
  leadNT: '首攻（無王）',
  leadSuit: '首攻（王牌合約）',
  defenderLead: '防家領出',
  secondHand: '防家第二家',
  thirdHand: '防家第三家',
  fourthHand: '防家第四家',
  defenderDiscard: '防家墊牌或王吃',
  declarerLead: '坐莊方領出',
  declarerFollow: '坐莊方跟牌',
  declarerDiscard: '坐莊方墊牌或王吃',
}

export interface Decision {
  board: number
  contract: string
  declarer: Seat
  seat: Seat
  /** 1 to 13 */
  trick: number
  situation: Situation
  tkb: Card
  best: Card
  tkbScore: CardScore
  bestScore: CardScore
  /** Tricks, contract odds and score TKB's card gives up against the best */
  lossTricks: number
  lossSuccess: number
  lossScore: number
  samples: number
  attempts: number
  relaxed: number
}

export interface CompareRecord {
  board: number
  contract: string
  /** Decisions looked at, by situation (a decision with every card equal is not counted) */
  decisions: Partial<Record<Situation, number>>
  /** Only the decisions where TKB's card scored worse than the best */
  losses: Decision[]
  /** The sampler over every decision of the board (`decisions` counts those sampled, equal cards or not) */
  sampling: { decisions: number; layouts: number; attempts: number; relaxed: number }
}

export interface CompareOptions {
  samples: number
  seed: string
  objective: Objective
  ddBias: number
  /** Only the opening lead, or every card */
  points: 'lead' | 'all'
}

function situationOf(seat: Seat, declarer: Seat, trickCards: number, playLength: number, trump: string | null, following: boolean): Situation {
  const declaring = sameSide(seat, declarer)
  if (playLength === 0) return trump ? 'leadSuit' : 'leadNT'
  if (trickCards === 0) return declaring ? 'declarerLead' : 'defenderLead'
  if (!following) return declaring ? 'declarerDiscard' : 'defenderDiscard'
  if (declaring) return 'declarerFollow'
  return trickCards === 1 ? 'secondHand' : trickCards === 2 ? 'thirdHand' : 'fourthHand'
}

/** The board played by TKB, every decision compared; null when it was passed out */
export async function compareBoard(board: EvalBoard, kind: RobotKind, solver: Solver, options: CompareOptions): Promise<CompareRecord | null> {
  let state = await bidBoard(board, kind)
  const contract = state.contract
  if (!contract) return null
  const record: CompareRecord = { board: board.boardNo, contract: contractText(contract), decisions: {}, losses: [], sampling: { decisions: 0, layouts: 0, attempts: 0, relaxed: 0 } }
  const trump = contract.strain === 'N' ? null : contract.strain
  const vulnerable = isVulnerable(state.vul, contract.declarer)
  let point = 0
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    const card = await ruleBrain.play(kind, state, seat)
    const legal = legalCards(state, seat)
    const lead = state.play.length === 0
    if (legal.length > 1 && (options.points === 'all' || lead)) {
      const current = tricksOf(state).at(-1)
      const open = current && !current.winner ? current.cards : []
      const following = open.length === 0 || suitOf(card) === suitOf(open[0].card)
      const situation = situationOf(seat, contract.declarer, open.length, state.play.length, trump, following)
      // The decision is the declarer's when the card is dummy's: the knowledge is dummy's seat (it sees both hands)
      const knowledge = knowledgeOf(state, seat, kind)
      const sampling = sampleLayouts(knowledge.problem, options.samples, seededRandom(`${options.seed}:${board.boardNo}:${point}`))
      record.sampling.decisions++
      record.sampling.layouts += sampling.layouts.length
      record.sampling.attempts += sampling.attempts
      record.sampling.relaxed += sampling.relaxed
      const layouts = sampling.layouts.map((layout) => expandEquals(solver.solve(positionOf(knowledge, layout))))
      const scores = scoreCards(layouts, { contract, declaring: sameSide(seat, contract.declarer), vulnerable, won: tricksWon(state)[sideOf(seat)] }, options.ddBias)
      const best = bestCard(scores, options.objective)
      const mine = scores.find((s) => s.card === card)!
      const spread = Math.max(...scores.map((s) => objectiveValue(s, options.objective))) - Math.min(...scores.map((s) => objectiveValue(s, options.objective)))
      if (spread > 0) {
        record.decisions[situation] = (record.decisions[situation] ?? 0) + 1
        if (objectiveValue(best, options.objective) > objectiveValue(mine, options.objective)) {
          record.losses.push({
            board: board.boardNo,
            contract: record.contract,
            declarer: contract.declarer,
            seat,
            trick: Math.floor(state.play.length / 4) + 1,
            situation,
            tkb: card,
            best: best.card,
            tkbScore: mine,
            bestScore: best,
            lossTricks: best.meanTricks - mine.meanTricks,
            lossSuccess: best.pSuccess - mine.pSuccess,
            lossScore: best.meanScore - mine.meanScore,
            samples: sampling.layouts.length,
            attempts: sampling.attempts,
            relaxed: sampling.relaxed,
          })
        }
      }
      point++
    }
    state = playCard(state, seat, card)
  }
  return record
}

export interface SituationStats {
  situation: Situation
  decisions: number
  losses: number
  /** Average loss over all decisions of the situation (agreements count 0) */
  meanTricks: number
  meanSuccess: number
  meanScore: number
}

export interface CompareStudy {
  boards: number
  /** Decisions sampled, equal cards or not */
  sampled: number
  samples: number
  acceptance: number
  relaxed: number
  situations: SituationStats[]
  /** The decisions TKB lost most on, by the objective's loss */
  worst: Decision[]
}

export function compareStudy(records: readonly CompareRecord[], objective: Objective, worstCount = 25): CompareStudy {
  const by = new Map<Situation, { decisions: number; losses: number; tricks: number; success: number; score: number }>()
  let sampled = 0
  let samples = 0
  let attempts = 0
  let relaxed = 0
  const all: Decision[] = []
  for (const record of records) {
    sampled += record.sampling.decisions
    samples += record.sampling.layouts
    attempts += record.sampling.attempts
    relaxed += record.sampling.relaxed
    for (const [situation, n] of Object.entries(record.decisions) as [Situation, number][]) {
      const s = by.get(situation) ?? { decisions: 0, losses: 0, tricks: 0, success: 0, score: 0 }
      s.decisions += n
      by.set(situation, s)
    }
    for (const d of record.losses) {
      const s = by.get(d.situation)!
      s.losses++
      s.tricks += d.lossTricks
      s.success += d.lossSuccess
      s.score += d.lossScore
      all.push(d)
    }
  }
  const lossOf = (d: Decision) => (objective === 'tricks' ? d.lossTricks : objective === 'contract' ? d.lossSuccess : d.lossScore)
  return {
    boards: records.length,
    sampled,
    samples,
    acceptance: attempts ? samples / attempts : 0,
    relaxed: samples ? relaxed / samples : 0,
    situations: [...by]
      .map(([situation, s]) => ({ situation, decisions: s.decisions, losses: s.losses, meanTricks: s.tricks / s.decisions, meanSuccess: s.success / s.decisions, meanScore: s.score / s.decisions }))
      .sort((a, b) => b.meanScore * b.decisions - a.meanScore * a.decisions),
    worst: all.sort((a, b) => lossOf(b) - lossOf(a)).slice(0, worstCount),
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function compareReport(study: CompareStudy, heading: string, objective: Objective): string {
  const lines = [
    `## TKB 對單明手抽樣：${heading}`,
    '',
    `${study.boards} 副由四個 TKB 叫完打完；每個有選擇的出牌都用那一家看得到的牌抽樣、雙明手解出每張牌的結果（目標：${objective === 'tricks' ? '平均墩數' : objective === 'contract' ? '做成／倒合約的機率' : '平均得分'}）。所有牌結果一樣的決策（例如只差信號）不算。${study.sampled} 個決策每個抽 ${study.sampled ? Math.round(study.samples / study.sampled) : 0} 個佈局；抽樣接受率 ${pct(study.acceptance)}，放寬條件才抽到的 ${pct(study.relaxed)}。`,
    '',
    '| 情境 | 決策 | TKB 較差 | 平均損失（墩） | 平均損失（做成率） | 平均損失（分） |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const s of study.situations)
    lines.push(`| ${SITUATION_LABEL[s.situation]} | ${s.decisions} | ${s.losses}（${pct(s.losses / s.decisions)}） | ${s.meanTricks.toFixed(3)} | ${pct(s.meanSuccess)} | ${s.meanScore.toFixed(0)} |`)
  lines.push('', '### TKB 損失最多的決策', '', '| 副 | 合約 | 座位 | 第幾墩 | 情境 | TKB 出 | 最佳 | 墩差 | 做成率差 | 分差 | 抽樣 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const d of study.worst)
    lines.push(
      `| ${d.board} | ${d.contract} by ${d.declarer} | ${d.seat}${d.seat === partnerOf(d.declarer) ? '（夢家）' : ''} | ${d.trick} | ${SITUATION_LABEL[d.situation]} | ${d.tkb} | ${d.best} | ${d.lossTricks.toFixed(2)} | ${pct(d.lossSuccess)} | ${d.lossScore.toFixed(0)} | ${d.samples} |`,
    )
  lines.push('')
  return lines.join('\n')
}
