import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Call, Contract } from '../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../shared/board.ts'
import { sameSide, sideOf, suitOf, type Card, type Seat } from '../shared/cards.ts'
import { controllerOf, legalCards, makeCall, remainingCards, remainingTricks, tricksOf, tricksWon, turnOf, type BoardState } from '../shared/game.ts'
import { imps } from '../shared/imp.ts'
import { IMPORT_LIMITS, importedContent, replayImported, type ImportCode } from '../shared/imports.ts'
import { parseLin, type LinBoard } from '../shared/lin-import.ts'
import type { RobotKind } from '../shared/protocol.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'
import { duplicateScore } from '../shared/scoring.ts'
import { contractText } from './sim/board.ts'
import { expandEquals, pbnHand, type DdTable, type Position, type Solver } from './sim/dds.ts'

/**
 * The BBO comparison (`e6-t29`, eval/README.md): LIN files of boards someone played, walked decision
 * by decision. At each one TKB is asked what it would do from where that player sat (a call from the
 * hand and the calls before it, a card through `chooseCard`'s `View`), and where it differs from what
 * was played, double dummy says how much it matters. A measurement only: offline, on the developer's
 * computer, with no change to what the robot does.
 *
 * Every decision is judged on its own: the board goes on as the file has it, whatever TKB would have
 * done. The sums are therefore "how much the decisions differed by", not "how the boards would have ended".
 */

export type BidCategory = 'opening' | 'response' | 'rebid' | 'overcall' | 'competitive'
export type PlayRole = 'declarer' | 'defence'
export type PlayType = 'openingLead' | 'lead' | 'follow' | 'discard'
/** `bid:opening` or `play:declarer:lead`: a row of the report */
export type GroupKey = `bid:${BidCategory}` | `play:${PlayRole}:${PlayType}`

const BID_CATEGORIES: readonly BidCategory[] = ['opening', 'response', 'rebid', 'overcall', 'competitive']
const PLAY_TYPES: readonly PlayType[] = ['openingLead', 'lead', 'follow', 'discard']

const GROUP_LABEL = {
  opening: '開叫（前面都 Pass）',
  response: '答叫（同伴叫過，敵方沒叫）',
  rebid: '再叫（自己叫過，敵方沒叫）',
  overcall: '對抗（敵方叫過，我方沒叫）',
  competitive: '競叫（雙方都叫過）',
  declarer: '坐莊方',
  defence: '防家',
  openingLead: '首攻',
  lead: '領出',
  follow: '跟牌',
  discard: '墊牌或王吃',
} as const

/** What a BBO robot's name looks like in a LIN file; not checked against a real file yet, `--gib-pattern` overrides it */
export const GIB_NAMES = /^(gib|~~|robot$)/i

export interface DecisionFilter {
  /** Only these players, lower case; the declarer decides dummy's cards */
  players?: ReadonlySet<string>
  /** Only players with such a name */
  names?: RegExp
  /** Only the declaring side's or the defenders' cards, and no calls */
  side?: PlayRole
  only?: 'bidding' | 'play'
}

export interface CompareOptions {
  kind: RobotKind
  brain: RobotBrain
  /** Null: differences only, no double dummy */
  solver: Solver | null
  filter?: DecisionFilter
}

/** A call TKB would have made differently. The gains are for the side of the seat that called */
export interface BidDifference {
  kind: 'bid'
  board: number
  file: string
  group: GroupKey
  seat: Seat
  player: string
  hand: string
  /** The calls before this one, from the dealer */
  auction: string
  actual: Call
  tkb: Call
  /** Four TKBs finish the auction after each call; each contract is scored at its double-dummy tricks */
  dd?: { actualContract: string; tkbContract: string; actualNS: number; tkbNS: number; gainScore: number; gainImps: number }
}

/** A card TKB would have played differently. The gains are for the side of the seat that played */
export interface PlayDifference {
  kind: 'play'
  board: number
  file: string
  group: GroupKey
  seat: Seat
  player: string
  hand: string
  contract: string
  /** 1 to 13 */
  trick: number
  /** 1 to 4: the place in the trick */
  position: number
  actual: Card
  tkb: Card
  dd?: { actualTricks: number; tkbTricks: number; bestTricks: number; gainTricks: number; gainScore: number; gainImps: number }
}

export type Difference = BidDifference | PlayDifference

export interface BoardCompare {
  file: string
  board: number
  names: Record<Seat, string>
  auction: string
  contract: string
  /** The tricks the declarer took at the table (claims included); null when passed out */
  tricks: number | null
  claimed: boolean
  /** Decisions looked at, by row and by the player who made them */
  decisions: Partial<Record<GroupKey, number>>
  players: Record<string, { decisions: number; different: number }>
  differences: Difference[]
  robotErrors: number
  ddErrors: number
  /** What double dummy says of the contract reached, against par; all North–South's point of view */
  dd?: { tricks: number | null; scoreNS: number; parNS: number; parContracts: string[]; gapImps: number }
}

export interface CompareSkip {
  file: string
  /** The board's number in the file */
  board: number
  code: ImportCode
}

export interface CompareRun {
  kind: RobotKind
  files: number
  unreadable: { file: string; error: string }[]
  boards: BoardCompare[]
  skipped: CompareSkip[]
  /** The same board again, in the same file or another (downloads overlap) */
  duplicates: number
}

/** Which row a call belongs to: from the calls before it, passes aside */
export function bidCategory(calls: readonly { seat: Seat; call: Call }[], seat: Seat): BidCategory {
  const acted = calls.filter((c) => c.call !== 'P')
  if (!acted.length) return 'opening'
  const ours = acted.filter((c) => sameSide(c.seat, seat))
  if (ours.length === acted.length) return ours.some((c) => c.seat === seat) ? 'rebid' : 'response'
  return ours.length ? 'competitive' : 'overcall'
}

/** Which kind of card a decision is, from the cards on the table and what the seat may play */
export function playType(state: BoardState, seat: Seat): PlayType {
  if (!state.play.length) return 'openingLead'
  const open = openTrick(state)
  if (!open.length) return 'lead'
  return suitOf(legalCards(state, seat)[0]) === suitOf(open[0]) ? 'follow' : 'discard'
}

/** The cards of the trick being played, none when a new trick starts */
function openTrick(state: BoardState): Card[] {
  const current = tricksOf(state).at(-1)
  return current && !current.winner ? current.cards.map((p) => p.card) : []
}

/** The deal as DDS needs it just before the next card: the real cards of all four seats */
export function positionAt(state: BoardState): Position {
  const seat = turnOf(state)!
  const current = tricksOf(state).at(-1)
  const open = current && !current.winner ? current : null
  const contract = state.contract!
  return {
    trump: contract.strain === 'N' ? null : contract.strain,
    leader: open ? open.leader : seat,
    trick: open ? open.cards.map((p) => p.card) : [],
    hands: { N: remainingCards(state, 'N'), E: remainingCards(state, 'E'), S: remainingCards(state, 'S'), W: remainingCards(state, 'W') },
  }
}

/** The tricks a contract takes double dummy, from its declarer */
const ddTricks = (contract: Contract, table: DdTable) => table[contract.strain][contract.declarer]

/** North–South's score of a contract at its double-dummy tricks; 0 when passed out */
export function ddScoreNS(contract: Contract | null, table: DdTable, vul: Vulnerability): number {
  if (!contract) return 0
  const score = duplicateScore(contract, ddTricks(contract, table), isVulnerable(vul, contract.declarer))
  return sideOf(contract.declarer) === 'NS' ? score : -score
}

/** `3NX S`, or `Passed out` */
export const contractLabel = (contract: Contract | null) => (contract ? `${contractText(contract)} ${contract.declarer}` : 'Passed out')

/** Four robots finish the auction from `state`: where it ends */
async function finishAuction(state: BoardState, options: CompareOptions): Promise<Contract | null> {
  let next = state
  for (let i = 0; next.phase === 'auction'; i++) {
    if (i > IMPORT_LIMITS.callsMax) throw new Error('the auction does not end')
    const seat = turnOf(next)!
    const { call } = await options.brain.bid(options.kind, next, seat)
    next = makeCall(next, seat, call)
  }
  return next.contract
}

const wanted = (filter: DecisionFilter, name: string) => {
  if (filter.players && !filter.players.has(name.toLowerCase())) return false
  return !filter.names || filter.names.test(name)
}

/** Every decision of a board; null when the board cannot be replayed */
export async function compareBoard(board: LinBoard, file: string, options: CompareOptions): Promise<BoardCompare | null> {
  const final = replayImported(board)
  if (typeof final === 'string') return null
  const { kind, brain, solver, filter = {} } = options
  const name = (seat: Seat) => board.names[seat]
  const record: BoardCompare = {
    file,
    board: final.boardNo,
    names: board.names,
    auction: final.auction.map((c) => c.call).join('-'),
    contract: contractLabel(final.contract),
    tricks: final.contract ? (final.result?.declarerTricks ?? null) : null,
    claimed: !!final.result?.claimed,
    decisions: {},
    players: {},
    differences: [],
    robotErrors: 0,
    ddErrors: 0,
  }
  const tally = (group: GroupKey, player: string) => {
    record.decisions[group] = (record.decisions[group] ?? 0) + 1
    ;(record.players[player] ??= { decisions: 0, different: 0 }).decisions++
  }
  const differed = (difference: Difference) => {
    record.players[difference.player].different++
    record.differences.push(difference)
  }

  // The bare board: nothing a person alerted reaches the robot, only the calls themselves
  const calls = final.auction.map(({ seat, call }) => ({ seat, call }))
  const bare: BoardState = { boardNo: final.boardNo, dealer: final.dealer, vul: final.vul, hands: final.hands, auction: [], contract: null, play: [], phase: 'auction' }

  let table: DdTable | null = null
  if (solver) {
    try {
      table = solver.table(final.hands)
      const par = solver.par(table, final.dealer, final.vul)
      const scoreNS = ddScoreNS(final.contract, table, final.vul)
      record.dd = {
        tricks: final.contract ? ddTricks(final.contract, table) : null,
        scoreNS,
        parNS: par.ns,
        parContracts: par.contracts,
        gapImps: Math.abs(imps(scoreNS - par.ns)),
      }
    } catch {
      record.ddErrors++
    }
  }

  if (filter.only !== 'play' && !filter.side) {
    for (let i = 0; i < calls.length; i++) {
      const { seat, call: actual } = calls[i]
      if (!wanted(filter, name(seat))) continue
      const state: BoardState = { ...bare, auction: calls.slice(0, i) }
      let tkb: Call
      try {
        tkb = (await brain.bid(kind, state, seat)).call
      } catch {
        record.robotErrors++
        continue
      }
      const group: GroupKey = `bid:${bidCategory(state.auction, seat)}`
      tally(group, name(seat))
      if (tkb === actual) continue
      const difference: BidDifference = {
        kind: 'bid',
        board: final.boardNo,
        file,
        group,
        seat,
        player: name(seat),
        hand: pbnHand(final.hands[seat]),
        auction: state.auction.map((c) => c.call).join('-'),
        actual,
        tkb,
      }
      if (table) {
        try {
          const finish = (call: Call) => finishAuction(makeCall(state, seat, call), options)
          const [actualEnd, tkbEnd] = [await finish(actual), await finish(tkb)]
          const [actualNS, tkbNS] = [ddScoreNS(actualEnd, table, final.vul), ddScoreNS(tkbEnd, table, final.vul)]
          const gainScore = sideOf(seat) === 'NS' ? tkbNS - actualNS : actualNS - tkbNS
          difference.dd = { actualContract: contractLabel(actualEnd), tkbContract: contractLabel(tkbEnd), actualNS, tkbNS, gainScore, gainImps: imps(gainScore) }
        } catch {
          record.ddErrors++
        }
      }
      differed(difference)
    }
  }

  const contract = final.contract
  if (contract && filter.only !== 'bidding') {
    const start: BoardState = { ...bare, auction: calls, contract, phase: 'play' }
    for (let i = 0; i < final.play.length; i++) {
      const { seat, card: actual } = final.play[i]
      const state: BoardState = { ...start, play: final.play.slice(0, i) }
      // One legal card is no decision
      if (legalCards(state, seat).length < 2) continue
      const role: PlayRole = sameSide(seat, contract.declarer) ? 'declarer' : 'defence'
      const player = name(controllerOf(state, seat))
      if (filter.side && filter.side !== role) continue
      if (!wanted(filter, player)) continue
      let tkb: Card
      try {
        tkb = await brain.play(kind, state, seat)
      } catch {
        record.robotErrors++
        continue
      }
      const group: GroupKey = `play:${role}:${playType(state, seat)}`
      tally(group, player)
      if (tkb === actual) continue
      const difference: PlayDifference = {
        kind: 'play',
        board: final.boardNo,
        file,
        group,
        seat,
        player,
        hand: pbnHand(remainingCards(state, seat)),
        contract: record.contract,
        trick: Math.floor(i / 4) + 1,
        position: (i % 4) + 1,
        actual,
        tkb,
      }
      if (solver) {
        try {
          difference.dd = playGain(state, seat, actual, tkb, solver)
        } catch {
          record.ddErrors++
        }
      }
      differed(difference)
    }
  }
  return record
}

/** Double dummy on two cards from one position, for the side of the seat that plays */
export function playGain(state: BoardState, seat: Seat, actual: Card, tkb: Card, solver: Solver): NonNullable<PlayDifference['dd']> {
  const tricks = expandEquals(solver.solve(positionAt(state)))
  const actualTricks = tricks.get(actual)
  const tkbTricks = tricks.get(tkb)
  if (actualTricks === undefined || tkbTricks === undefined) throw new Error(`DDS did not rate ${actual} and ${tkb}`)
  const contract = state.contract!
  const declaring = sameSide(seat, contract.declarer)
  const won = tricksWon(state)[sideOf(contract.declarer)]
  const score = (side: number) => {
    const made = duplicateScore(contract, won + (declaring ? side : remainingTricks(state) - side), isVulnerable(state.vul, contract.declarer))
    return declaring ? made : -made
  }
  const gainScore = score(tkbTricks) - score(actualTricks)
  return { actualTricks, tkbTricks, bestTricks: Math.max(...tricks.values()), gainTricks: tkbTricks - actualTricks, gainScore, gainImps: imps(gainScore) }
}

/** The LIN files under the paths given: a file as it is named, a folder's `.lin` files at any depth */
export function linFiles(paths: readonly string[]): string[] {
  const out: string[] = []
  const walk = (path: string, named: boolean) => {
    let isFolder: boolean
    try {
      isFolder = statSync(path).isDirectory()
    } catch {
      // Named but missing: reading it reports the problem
      if (named) out.push(path)
      return
    }
    if (!isFolder) {
      if (named || path.toLowerCase().endsWith('.lin')) out.push(path)
      return
    }
    for (const entry of readdirSync(path).sort()) walk(join(path, entry), false)
  }
  for (const path of paths) walk(path, true)
  return out
}

/** Every board of the texts given, as `[file, text]`; nothing in a file stops the others */
export async function compareTexts(sources: Iterable<readonly [string, string]>, options: CompareOptions, progress?: (boards: number) => void): Promise<CompareRun> {
  const run: CompareRun = { kind: options.kind, files: 0, unreadable: [], boards: [], skipped: [], duplicates: 0 }
  const seen = new Set<string>()
  for (const [file, text] of sources) {
    run.files++
    const { boards, problems } = parseLin(text)
    for (const { board, code } of problems) run.skipped.push({ file, board, code })
    for (const board of boards) {
      const state = replayImported(board)
      if (typeof state === 'string') {
        run.skipped.push({ file, board: board.boardNo, code: state })
        continue
      }
      const content = importedContent(state, board.names)
      if (seen.has(content)) {
        run.duplicates++
        continue
      }
      seen.add(content)
      const record = await compareBoard(board, file, options)
      if (record) run.boards.push(record)
      progress?.(run.boards.length)
    }
  }
  return run
}

/** Reads the files and compares them; a file that cannot be read is reported, the rest go on */
export async function compareFiles(files: readonly string[], options: CompareOptions, progress?: (boards: number) => void): Promise<CompareRun> {
  const unreadable: CompareRun['unreadable'] = []
  const sources = function* (): Generator<readonly [string, string]> {
    for (const file of files) {
      try {
        yield [file, readFileSync(file, 'utf8')]
      } catch (error) {
        unreadable.push({ file, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const run = await compareTexts(sources(), options, progress)
  return { ...run, unreadable }
}

export interface GroupStats {
  key: GroupKey
  decisions: number
  different: number
  /** Differences double dummy rated: equal, or better for one of the two */
  ddSame: number
  tkbBetter: number
  actualBetter: number
  /** The sums of the gains over those differences (TKB minus what was played) */
  tricks: number
  imps: number
}

export interface CompareSummary {
  boards: number
  passedOut: number
  claimed: number
  groups: GroupStats[]
  bidding: Totals
  play: Totals
  players: { player: string; decisions: number; different: number }[]
  /** Over the boards double dummy rated: how far the contract reached is from par */
  par: { boards: number; atPar: number; meanGapImps: number }
  robotErrors: number
  ddErrors: number
}

export interface Totals {
  decisions: number
  different: number
  tricks: number
  imps: number
}

/** Groups in the report's order, then the sums */
export function summarize(run: Pick<CompareRun, 'boards'>): CompareSummary {
  const stats = new Map<GroupKey, GroupStats>()
  const group = (key: GroupKey) => {
    let row = stats.get(key)
    if (!row) stats.set(key, (row = { key, decisions: 0, different: 0, ddSame: 0, tkbBetter: 0, actualBetter: 0, tricks: 0, imps: 0 }))
    return row
  }
  const players = new Map<string, { player: string; decisions: number; different: number }>()
  let [gapBoards, atPar, gaps, robotErrors, ddErrors] = [0, 0, 0, 0, 0]
  for (const board of run.boards) {
    for (const [key, n] of Object.entries(board.decisions) as [GroupKey, number][]) group(key).decisions += n
    for (const [player, counts] of Object.entries(board.players)) {
      const row = players.get(player) ?? { player, decisions: 0, different: 0 }
      row.decisions += counts.decisions
      row.different += counts.different
      players.set(player, row)
    }
    for (const difference of board.differences) {
      const row = group(difference.group)
      row.different++
      if (!difference.dd) continue
      // A card is rated by its tricks; a call has none of its own, only the points of where it ends
      const tricks = difference.kind === 'play' ? (difference.dd as NonNullable<PlayDifference['dd']>).gainTricks : 0
      const measure = difference.kind === 'play' ? tricks : difference.dd.gainScore
      if (measure > 0) row.tkbBetter++
      else if (measure < 0) row.actualBetter++
      else row.ddSame++
      row.tricks += tricks
      row.imps += difference.dd.gainImps
    }
    if (board.dd) {
      gapBoards++
      gaps += board.dd.gapImps
      if (board.dd.scoreNS === board.dd.parNS) atPar++
    }
    robotErrors += board.robotErrors
    ddErrors += board.ddErrors
  }
  const rank = (key: GroupKey) => {
    const parts = key.split(':')
    return parts[0] === 'bid' ? BID_CATEGORIES.indexOf(parts[1] as BidCategory) : 10 + (parts[1] === 'declarer' ? 0 : 10) + PLAY_TYPES.indexOf(parts[2] as PlayType)
  }
  const groups = [...stats.values()].sort((a, b) => rank(a.key) - rank(b.key))
  const totals = (prefix: string): Totals => {
    const rows = groups.filter((row) => row.key.startsWith(prefix))
    const sum = (f: (row: GroupStats) => number) => rows.reduce((total, row) => total + f(row), 0)
    return { decisions: sum((r) => r.decisions), different: sum((r) => r.different), tricks: sum((r) => r.tricks), imps: sum((r) => r.imps) }
  }
  return {
    boards: run.boards.length,
    passedOut: run.boards.filter((b) => b.contract === contractLabel(null)).length,
    claimed: run.boards.filter((b) => b.claimed).length,
    groups,
    bidding: totals('bid:'),
    play: totals('play:'),
    players: [...players.values()].sort((a, b) => b.decisions - a.decisions || a.player.localeCompare(b.player)),
    par: { boards: gapBoards, atPar, meanGapImps: gapBoards ? gaps / gapBoards : 0 },
    robotErrors,
    ddErrors,
  }
}

/** The differences TKB gains or loses most on, biggest first; the same order every run */
export function extremes(run: Pick<CompareRun, 'boards'>, sign: 1 | -1, count: number): Difference[] {
  const rated = run.boards.flatMap((b) => b.differences).filter((d) => d.dd && sign * d.dd.gainImps > 0)
  const place = (d: Difference) => `${d.file}\n${String(d.board).padStart(5, '0')}\n${d.kind}`
  return rated
    .sort((a, b) => sign * (b.dd!.gainImps - a.dd!.gainImps) || sign * (b.dd!.gainScore - a.dd!.gainScore) || place(a).localeCompare(place(b)))
    .slice(0, count)
}

const percent = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—')
const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
const cell = (text: string) => text.replace(/\|/g, '/')

function groupLabel(key: GroupKey): string {
  const parts = key.split(':') as (keyof typeof GROUP_LABEL)[]
  return parts[0] === ('bid' as string) ? GROUP_LABEL[parts[1]] : `${GROUP_LABEL[parts[1]]}・${GROUP_LABEL[parts[2]]}`
}

function differenceRows(differences: readonly Difference[]): string[] {
  if (!differences.length) return ['（沒有）']
  return [
    '| 檔案 | 副 | 合約或叫牌過程 | 座位（玩家） | 手牌 | 情境 | 實際 | TKB | DD |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...differences.map((d) => {
      const place = cell(d.file.split(/[\\/]/).at(-1) ?? d.file)
      const who = `${d.seat}（${cell(d.player)}）`
      if (d.kind === 'bid') {
        const dd = d.dd ? `${d.dd.actualContract} → ${d.dd.tkbContract}，${signed(d.dd.gainScore)} 分，${signed(d.dd.gainImps)} IMP` : '—'
        return `| ${place} | ${d.board} | ${d.auction || '（開叫）'} | ${who} | ${d.hand} | ${groupLabel(d.group)} | ${d.actual} | ${d.tkb} | ${dd} |`
      }
      const dd = d.dd ? `${d.dd.actualTricks} → ${d.dd.tkbTricks} 墩（最佳 ${d.dd.bestTricks}），${signed(d.dd.gainScore)} 分，${signed(d.dd.gainImps)} IMP` : '—'
      return `| ${place} | ${d.board} | ${d.contract} 第 ${d.trick} 墩第 ${d.position} 張 | ${who} | ${d.hand} | ${groupLabel(d.group)} | ${d.actual} | ${d.tkb} | ${dd} |`
    }),
  ]
}

/** The Markdown report */
export function compareReport(run: CompareRun, options: { top: number; filterText: string; dd: boolean }): string {
  const summary = summarize(run)
  const line = (name: string, t: Totals, unit: boolean) =>
    `| ${name} | ${t.decisions} | ${t.different} | ${percent(t.different, t.decisions)} | ${unit ? signed(t.tricks) : '—'} | ${signed(t.imps)} |`
  const codes = new Map<ImportCode, number>()
  for (const { code } of run.skipped) codes.set(code, (codes.get(code) ?? 0) + 1)
  const parts = [
    `# BBO 比對：TKB（${run.kind}）對 LIN 牌局`,
    '',
    `${run.files} 個檔案，比對 ${summary.boards} 副（${summary.passedOut} 副四家 Pass、${summary.claimed} 副以攤牌結束，攤牌之後沒有決策）；跳過 ${run.skipped.length} 副、重複 ${run.duplicates} 副、讀不到 ${run.unreadable.length} 個檔案。機器人出錯 ${summary.robotErrors} 次、DDS 出錯 ${summary.ddErrors} 次（那些決策不算或沒有 DD）。範圍：${options.filterText}。`,
    '',
    '**讀法**：只有一張合法牌的不算決策。每個決策各自比較，牌局照 LIN 繼續，所以加總是「決定差多少」，不是「這些牌會變成幾分」。損益都是 TKB 減實際、從那一家的方向看，正的是 TKB 較好。出牌用雙明手算兩張牌之後各拿幾墩：莊家和防家都看得到全部的牌，所以飛牌、誘騙這類決定看不準。叫牌是兩個叫品之後都由四個 TKB 叫完，比最後合約的雙明手分數；後面的叫品不是真實牌局的，LIN 的玩家打的制度也可能跟 TKB 不同（制度不同本來就會叫不一樣），只能當線索。',
    '',
    '## 彙總',
    '',
    '| | 決策 | 不同 | 不同率 | DD 墩 | DD IMP |',
    '| --- | --- | --- | --- | --- | --- |',
    line('叫牌', summary.bidding, false),
    line('出牌', summary.play, true),
    '',
    '## 分組',
    '',
    '「TKB 好／實際好／一樣」只數 DD 算過的不同決定。',
    '',
    '| 分組 | 決策 | 不同 | 不同率 | TKB 好 | 實際好 | 一樣 | DD 墩 | DD IMP |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.groups.map((g) =>
      `| ${groupLabel(g.key)} | ${g.decisions} | ${g.different} | ${percent(g.different, g.decisions)} | ${g.tkbBetter} | ${g.actualBetter} | ${g.ddSame} | ${g.key.startsWith('play:') ? signed(g.tricks) : '—'} | ${signed(g.imps)} |`,
    ),
    '',
    '## 玩家',
    '',
    '| 玩家 | 決策 | 不同 | 不同率 |',
    '| --- | --- | --- | --- |',
    ...summary.players.map((p) => `| ${cell(p.player)} | ${p.decisions} | ${p.different} | ${percent(p.different, p.decisions)} |`),
    '',
  ]
  if (options.dd) {
    parts.push(
      '## 最後合約對 par',
      '',
      `${summary.par.boards} 副有雙明手結果：${summary.par.atPar} 副最後合約的雙明手分數等於 par，平均差 ${summary.par.meanGapImps.toFixed(2)} IMP（絕對值，不分哪一方）。`,
      '',
      `## TKB 損失最大（前 ${options.top}）`,
      '',
      ...differenceRows(extremes(run, -1, options.top)),
      '',
      `## TKB 較好最多（前 ${options.top}）`,
      '',
      ...differenceRows(extremes(run, 1, options.top)),
      '',
    )
  } else parts.push('沒有算雙明手（`--no-dd`），所以只有不同率。', '')
  if (run.skipped.length || run.unreadable.length) {
    parts.push(
      '## 跳過的',
      '',
      ...[...codes].map(([code, n]) => `- \`${code}\`：${n} 副`),
      ...run.skipped.slice(0, 50).map((s) => `  - ${cell(s.file)} 第 ${s.board} 副：\`${s.code}\``),
      ...run.unreadable.map((u) => `- 讀不到 ${cell(u.file)}：${cell(u.error)}`),
      '',
    )
  }
  return parts.join('\n')
}
