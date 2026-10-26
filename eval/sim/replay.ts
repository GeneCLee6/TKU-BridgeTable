import { isVulnerable } from '../../shared/board.ts'
import type { Card, Seat, Suit } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf, type BoardState } from '../../shared/game.ts'
import { imps } from '../../shared/imp.ts'
import type { RobotBrain } from '../../shared/robot/brain.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { duplicateScore } from '../../shared/scoring.ts'
import { evalBoard } from '../deals.ts'
import { parseContract } from './board.ts'
import { defeatNeeds, handOf, LEAD_TYPE_LABEL, leadType, SAMPLED_BIASES, type LeadRecord, type LeadType } from './leads.ts'

/**
 * Replaying the opening leads of a leads file with this checkout's rules (eval/sim/README.md §8).
 * Every record holds the double-dummy result of every lead on its board, so a new lead rule can
 * be judged on a million boards without solving anything again: the board is dealt from the
 * seed, the recorded auction is bid again, TKB (only its own `View`) chooses the lead, and the
 * recorded results give the old lead (the record's `tkb`) against the new one. A record with
 * `sampled` also gives the leader's single-dummy estimate of both, with the double-dummy bias
 * taken off the declarer (README §2).
 */

/** The board of a record as it stood at the opening lead: dealt from the seed, bid as recorded */
export function stateAtLead(record: LeadRecord, seed: string): BoardState {
  let state = newBoard(record.board, evalBoard(record.board, seed).hands)
  for (const call of record.auction.split('-')) state = makeCall(state, turnOf(state)!, call)
  if (!state.contract || state.contract.declarer !== record.declarer) throw new Error(`board ${record.board}: the auction does not give the recorded contract`)
  return state
}

/** The lead this checkout's TKB (or `brain`) makes on the record's board */
export async function replayLead(record: LeadRecord, seed: string, brain: RobotBrain = ruleBrain): Promise<Card> {
  return brain.play(record.system, stateAtLead(record, seed), record.leader as Seat)
}

/** Running sums for a mean and its standard error */
class Mean {
  n = 0
  private sum = 0
  private squares = 0
  add(x: number) {
    this.n++
    this.sum += x
    this.squares += x * x
  }
  get mean() {
    return this.n ? this.sum / this.n : 0
  }
  get error() {
    if (this.n < 2) return 0
    const variance = (this.squares - this.sum * this.sum / this.n) / (this.n - 1)
    return Math.sqrt(Math.max(0, variance) / this.n)
  }
}

export type ContractKind = 'notrump' | 'major' | 'minor'
const kindOf = (strain: string): ContractKind => (strain === 'N' ? 'notrump' : 'SH'.includes(strain) ? 'major' : 'minor')
export const CONTRACT_KIND_LABEL: Record<ContractKind | 'all', string> = { all: '全部', notrump: '無王', major: '高花', minor: '低花' }

class Group {
  boards = 0
  changed = 0
  tricks = new Mean()
  defeatOld = 0
  defeatNew = 0
  imps = new Mean()
  /** Over the changed boards with a sampled estimate */
  sampledTricks = new Mean()
  sampledScore: Record<string, Mean> = Object.fromEntries(SAMPLED_BIASES.map((b) => [String(b), new Mean()]))
  sampledDefeat: Record<string, Mean> = Object.fromEntries(SAMPLED_BIASES.map((b) => [String(b), new Mean()]))
}

export interface GroupStats {
  boards: number
  /** Boards whose lead changed */
  changed: number
  /** New minus old, per board of the group (unchanged boards count 0): tricks and IMPs on the actual deal */
  tricks: number
  tricksError: number
  imps: number
  impsError: number
  /** How often the old and the new lead defeat the contract */
  defeatOld: number
  defeatNew: number
  /** Per changed board with a sampled estimate: tricks, defeat odds and points by double-dummy bias */
  sampled?: { n: number; tricks: number; tricksError: number; byBias: { bias: number; defeat: number; defeatError: number; score: number; scoreError: number }[] }
}

export interface ReplayStudy {
  groups: Record<ContractKind | 'all', GroupStats>
  /** The changed leads by kind, old to new, most IMPs gained first */
  transitions: { kind: ContractKind; from: LeadType; to: LeadType; n: number; tricks: number; imps: number; sampledTricks?: number; sampledScore?: number }[]
}

/** Adds up old against new leads */
export class LeadReplayBuilder {
  private groups = { all: new Group(), notrump: new Group(), major: new Group(), minor: new Group() }
  private moves = new Map<string, { kind: ContractKind; from: LeadType; to: LeadType; n: number; tricks: number; imps: number; sn: number; sTricks: number; sScore: number }>()
  /** Boards whose lead changed */
  readonly changed: number[] = []

  add(record: LeadRecord, lead: Card) {
    const contract = parseContract(record.contract, record.declarer)
    const kind = kindOf(contract.strain)
    const vulnerable = isVulnerable(record.vul, record.declarer)
    const defenders = (tricks: number) => -duplicateScore(contract, 13 - tricks, vulnerable)
    const old = record.dd[record.tkb]
    const now = record.dd[lead]
    const need = defeatNeeds(record)
    const gain = imps(defenders(now) - defenders(old))
    const moved = lead !== record.tkb
    if (moved) this.changed.push(record.board)
    for (const g of [this.groups.all, this.groups[kind]]) {
      g.boards++
      if (moved) g.changed++
      g.tricks.add(now - old)
      g.imps.add(gain)
      if (old >= need) g.defeatOld++
      if (now >= need) g.defeatNew++
      if (moved && record.sampled) {
        g.sampledTricks.add(record.sampled.tricks[lead] - record.sampled.tricks[record.tkb])
        for (const bias of SAMPLED_BIASES) {
          const b = record.sampled.biased?.[String(bias)]
          if (!b) continue
          g.sampledScore[String(bias)].add(b.score[lead] - b.score[record.tkb])
          g.sampledDefeat[String(bias)].add(b.defeat[lead] - b.defeat[record.tkb])
        }
      }
    }
    if (!moved) return
    const trump = contract.strain === 'N' ? null : (contract.strain as Suit)
    const hand = handOf(record)
    const from = leadType(hand, record.tkb, trump, record.partnerSuits)
    const to = leadType(hand, lead, trump, record.partnerSuits)
    const key = `${kind}|${from}|${to}`
    const m = this.moves.get(key) ?? { kind, from, to, n: 0, tricks: 0, imps: 0, sn: 0, sTricks: 0, sScore: 0 }
    m.n++
    m.tricks += now - old
    m.imps += gain
    const b = record.sampled?.biased?.['0']
    if (record.sampled && b) {
      m.sn++
      m.sTricks += record.sampled.tricks[lead] - record.sampled.tricks[record.tkb]
      m.sScore += b.score[lead] - b.score[record.tkb]
    }
    this.moves.set(key, m)
  }

  build(): ReplayStudy {
    const stats = (g: Group): GroupStats => {
      const s: GroupStats = {
        boards: g.boards,
        changed: g.changed,
        tricks: g.tricks.mean,
        tricksError: g.tricks.error,
        imps: g.imps.mean,
        impsError: g.imps.error,
        defeatOld: g.boards ? g.defeatOld / g.boards : 0,
        defeatNew: g.boards ? g.defeatNew / g.boards : 0,
      }
      if (g.sampledTricks.n) {
        s.sampled = {
          n: g.sampledTricks.n,
          tricks: g.sampledTricks.mean,
          tricksError: g.sampledTricks.error,
          byBias: SAMPLED_BIASES.filter((b) => g.sampledScore[String(b)].n).map((bias) => ({
            bias,
            defeat: g.sampledDefeat[String(bias)].mean,
            defeatError: g.sampledDefeat[String(bias)].error,
            score: g.sampledScore[String(bias)].mean,
            scoreError: g.sampledScore[String(bias)].error,
          })),
        }
      }
      return s
    }
    const g = this.groups
    return {
      groups: { all: stats(g.all), notrump: stats(g.notrump), major: stats(g.major), minor: stats(g.minor) },
      transitions: [...this.moves.values()]
        .map((m) => ({
          kind: m.kind,
          from: m.from,
          to: m.to,
          n: m.n,
          tricks: m.tricks / m.n,
          imps: m.imps / m.n,
          ...(m.sn ? { sampledTricks: m.sTricks / m.sn, sampledScore: m.sScore / m.sn } : {}),
        }))
        .sort((a, b) => b.imps * b.n - a.imps * a.n),
    }
  }
}

const signed = (x: number, digits: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(digits)}`
const pct = (x: number) => `${(100 * x).toFixed(1)}%`

/** The replay as Markdown */
export function replayReport(study: ReplayStudy, title: string): string {
  const lines = [`## 首攻重播：${title}`, '']
  lines.push('紀錄裡每一張首攻的雙明手結果不變，只換這個版本的 TKB 選的首攻；「新 − 舊」是每副的平均（沒變的副算 0），IMP 用實際牌局的得分差換算。', '')
  lines.push('| 合約 | 副數 | 首攻改變 | 墩（新 − 舊） | IMP／副（新 − 舊） | 倒合約 舊 → 新 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  const kinds = ['all', 'notrump', 'major', 'minor'] as const
  for (const k of kinds) {
    const s = study.groups[k]
    if (!s.boards) continue
    lines.push(`| ${CONTRACT_KIND_LABEL[k]} | ${s.boards} | ${s.changed}（${pct(s.changed / s.boards)}） | ${signed(s.tricks, 4)} ± ${s.tricksError.toFixed(4)} | ${signed(s.imps, 4)} ± ${s.impsError.toFixed(4)} | ${pct(s.defeatOld)} → ${pct(s.defeatNew)} |`)
  }
  const sampled = kinds.filter((k) => study.groups[k].sampled)
  if (sampled.length) {
    lines.push('', '### 單明手抽樣（首攻者自己的佈局，只算首攻改變的副）', '')
    lines.push('莊家扣掉雙明手偏差 t 墩後（README §2），新首攻比舊首攻多倒合約的比例與多得的分數（防家的角度）。', '')
    lines.push('| 合約 | 副數 | 墩（新 − 舊） | t | 倒合約（新 − 舊） | 分數（新 − 舊） |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const k of sampled) {
      const s = study.groups[k].sampled!
      for (const [i, b] of s.byBias.entries()) {
        const head = i === 0 ? `| ${CONTRACT_KIND_LABEL[k]} | ${s.n} | ${signed(s.tricks, 3)} ± ${s.tricksError.toFixed(3)} ` : '| | | '
        lines.push(`${head}| ${b.bias} | ${signed(100 * b.defeat, 2)} ± ${(100 * b.defeatError).toFixed(2)} 個百分點 | ${signed(b.score, 1)} ± ${b.scoreError.toFixed(1)} |`)
      }
    }
  }
  if (study.transitions.length) {
    lines.push('', '### 改變的首攻（舊 → 新，依總 IMP 排序）', '')
    lines.push('| 合約 | 舊 | 新 | 副數 | 墩 | IMP | 抽樣：墩 | 抽樣：分 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const t of study.transitions.slice(0, 30)) {
      const s = t.sampledTricks === undefined ? '| | ' : `| ${signed(t.sampledTricks, 3)} | ${signed(t.sampledScore!, 1)} `
      lines.push(`| ${CONTRACT_KIND_LABEL[t.kind]} | ${LEAD_TYPE_LABEL[t.from]} | ${LEAD_TYPE_LABEL[t.to]} | ${t.n} | ${signed(t.tricks, 3)} | ${signed(t.imps, 3)} ${s}|`)
    }
  }
  return lines.join('\n') + '\n'
}
