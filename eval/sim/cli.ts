import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRobotKind, type RobotKind } from '../../shared/protocol.ts'
import { readArgs } from '../config.ts'
import { EVAL_SEED, evalBoard } from '../deals.ts'
import { bidBoard } from './board.ts'
import { compareReport, compareStudy, type CompareOptions, type CompareRecord } from './compare.ts'
import { BiddingStudyBuilder, biddingReport, CATEGORIES, COMPETE_CATEGORIES, CONSTRUCTIVE, practiceDeals, type BiddingCategory, type BiddingRecord, type Example, type PracticeDeal } from './bidding.ts'
import { loadSolver } from './dds.ts'
import type { Job, ReplayResult, TableRecord } from './jobs.ts'
import { LeadStudyBuilder, leadReport, type LeadRecord } from './leads.ts'
import { LeadReplayBuilder, replayReport } from './replay.ts'
import { chunked, defaultThreads, Pool } from './pool.ts'
import { clock, Progress } from './progress.ts'
import type { Objective } from './score.ts'
import { JsonlStore } from './store.ts'
import { hcp, SEATS, SUITS, type Card, type Seat } from '../../shared/cards.ts'
import { legalCards, playCard, remainingCards, turnOf } from '../../shared/game.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'

/**
 * The offline simulations on the command line (eval/sim/README.md):
 *
 *   npm run sim -- bench [--deals 200] [--threads N]
 *   npm run sim -- tables --deals N [--from 1] [--seed s] [--threads N] [--out file]
 *   npm run sim -- leads --deals N [--from 1] [--seed s] [--system tku|gib] [--samples 0] [--threads N] [--out file] [--report file] [--analyse]
 *   npm run sim -- compare --deals N [--from 1] [--seed s] [--system tku|gib] [--samples 30] [--objective score|tricks|contract]
 *                          [--dd-bias 0] [--points lead|all|defence] [--threads N] [--out file] [--report file] [--analyse]
 *   npm run sim -- replay --out leads.jsonl [--from 1 --deals N | --boards file] [--report file] [--changed file]
 *   npm run sim -- bidding --deals N [--from 1] [--seed s] [--system tku|gib] [--threads N] [--out file] [--report file]
 *                          [--practice dir] [--analyse]
 *   npm run sim -- compete …   (the bidding study, only the competitive decisions)
 *
 * Results go to eval/sim/data/ (not committed) a line a board, and a run picks up where the file
 * left off.
 */

const USAGE = [
  'usage: npm run sim -- <bench|tables|leads|compare|replay|bidding|compete> [options]',
  '  bench    [--deals 200] [--threads N]',
  '  tables   --deals N [--from 1] [--seed s] [--threads N] [--out file]',
  '  leads    --deals N [--from 1] [--seed s] [--system tku|gib] [--samples 0] [--threads N] [--out file] [--report file] [--analyse]',
  '  compare  --deals N [--from 1] [--seed s] [--system tku|gib] [--samples 30] [--objective score|tricks|contract] [--dd-bias 0]',
  '           [--points lead|all|defence] [--threads N] [--out file] [--report file] [--analyse]',
  '  replay   --out leads.jsonl [--from 1 --deals N | --boards file] [--seed s] [--report file] [--changed file]',
  '  bidding  --deals N [--from 1] [--seed s] [--system tku|gib] [--threads N] [--out file] [--report file] [--practice dir] [--analyse]',
  '  compete  the same as bidding, only the competitive decisions',
  '  --boards file: only the board numbers in the file (leads, compare, replay)',
].join('\n')

const DATA_DIR = resolve(fileURLToPath(new URL('./data/', import.meta.url)))

/**
 * A fingerprint of TKB's rules (every file under shared/robot/), in the names of the leads and
 * compare files: a run resumes only boards played by the same rules, and changing a rule starts
 * a new file instead of mixing the two
 */
function rulesFingerprint(): string {
  const dir = resolve(fileURLToPath(new URL('../../shared/robot/', import.meta.url)))
  const hash = createHash('sha256')
  for (const file of readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts')).sort()) {
    hash.update(file.replaceAll('\\', '/')).update(readFileSync(resolve(dir, file)))
  }
  return hash.digest('hex').slice(0, 8)
}

interface Common {
  seed: string
  from: number
  deals: number
  threads: number
  system: RobotKind
  /** `--boards file`: only these board numbers (one a line), instead of `from` to `from + deals - 1` */
  only?: Set<number>
}

function common(args: Map<string, string>): Common {
  const system = args.get('system') ?? 'tku'
  if (!isRobotKind(system)) throw new Error(`--system is tku or gib, not "${system}"`)
  const deals = Number(args.get('deals') ?? 200)
  const from = Number(args.get('from') ?? 1)
  const threads = Number(args.get('threads') ?? defaultThreads())
  if (!Number.isInteger(deals) || deals < 1) throw new Error('--deals must be a whole number of boards')
  if (!Number.isInteger(from) || from < 1) throw new Error('--from must be a board number')
  if (!Number.isInteger(threads) || threads < 1) throw new Error('--threads must be a whole number')
  const list = args.get('boards')
  const only = list ? new Set(readFileSync(list, 'utf8').split(/\s+/).filter(Boolean).map(Number)) : undefined
  if (only && [...only].some((n) => !Number.isInteger(n) || n < 1)) throw new Error('--boards is a file of board numbers, one a line')
  return { seed: args.get('seed') ?? EVAL_SEED, from, deals, threads, system, only }
}

/** The boards of a run, for the report title */
const span = (c: Common) => (c.only ? `${c.only.size} 副（清單）` : `第 ${c.from}–${c.from + c.deals - 1} 副`)

/** The boards a run covers */
const covers = (c: Common, board: number) => (c.only ? c.only.has(board) : board >= c.from && board < c.from + c.deals)

/** Runs one kind of job over the boards not yet in the store, appending the results as they come */
async function runStudy<T extends { board: number }>(label: string, c: Common, store: JsonlStore<T>, chunk: number, job: (boards: number[]) => Job): Promise<number> {
  const all = c.only ? [...c.only].sort((a, b) => a - b) : Array.from({ length: c.deals }, (_, i) => c.from + i)
  const boards = all.filter((n) => !store.done.has(n))
  console.error(`${label}: ${all.length} boards ${c.only ? 'from the list' : `from ${c.from}`} of ${c.seed}; ${all.length - boards.length} already in ${store.path}`)
  if (!boards.length) return 0
  const pool = await Pool.start(Math.min(c.threads, boards.length))
  const progress = new Progress(boards.length, `${label} (${pool.size} threads)`)
  try {
    await pool.run(
      chunked(boards, chunk).map(job),
      (results) => store.append(results as unknown as T[]),
      (n) => progress.add(n),
    )
  } finally {
    await pool.close()
  }
  return progress.finish()
}

async function bench(args: Map<string, string>) {
  const c = common(args)
  console.log(`## DDS throughput (${c.threads} threads of ${defaultThreads() + 2} logical processors)\n`)
  const solver = await loadSolver()
  const time = (n: number, work: (i: number) => void) => {
    const started = performance.now()
    for (let i = 0; i < n; i++) work(i)
    return (performance.now() - started) / n
  }
  const single = 30
  const tableMs = time(single, (i) => solver.table(evalBoard(c.from + i, c.seed).hands))
  const leadMs = { N: 0, S: 0 }
  for (const trump of ['N', 'S'] as const)
    leadMs[trump] = time(single, (i) => solver.solve({ trump: trump === 'N' ? null : trump, leader: 'W', trick: [], hands: evalBoard(c.from + i, c.seed).hands }))
  // Positions later in the play: TKB plays the board out, the position at the start of some tricks is solved
  const later: Record<number, number[]> = { 3: [], 6: [], 9: [] }
  for (let i = 0; i < 10; i++) {
    let state = await bidBoard(evalBoard(c.from + i, c.seed), c.system)
    if (!state.contract) continue
    const trump = state.contract.strain === 'N' ? null : state.contract.strain
    while (state.phase === 'play') {
      const trick = state.play.length / 4 + 1
      if (state.play.length % 4 === 0 && later[trick]) {
        const leader = turnOf(state)!
        const hands = {} as Record<Seat, Card[]>
        for (const seat of SEATS) hands[seat] = remainingCards(state, seat)
        later[trick].push(time(1, () => solver.solve({ trump, leader, trick: [], hands })))
      }
      const seat = turnOf(state)!
      const card = legalCards(state, seat).length === 1 ? legalCards(state, seat)[0] : await ruleBrain.play(c.system, state, seat)
      state = playCard(state, seat, card)
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  console.log('| Single thread | ms each | per second |')
  console.log('| --- | --- | --- |')
  console.log(`| DD table (52 cards, 20 declarer × strain) | ${tableMs.toFixed(0)} | ${(1000 / tableMs).toFixed(1)} |`)
  console.log(`| Every lead solved, notrump (13 cards a hand) | ${leadMs.N.toFixed(1)} | ${(1000 / leadMs.N).toFixed(1)} |`)
  console.log(`| Every lead solved, spades | ${leadMs.S.toFixed(1)} | ${(1000 / leadMs.S).toFixed(1)} |`)
  for (const trick of [3, 6, 9]) console.log(`| Every card solved at trick ${trick} | ${mean(later[trick]).toFixed(2)} | ${(1000 / mean(later[trick])).toFixed(0)} |`)
  console.log('')

  const pool = await Pool.start(c.threads)
  const measure = async (label: string, job: (boards: number[]) => Job, chunk: number) => {
    const boards = Array.from({ length: c.deals }, (_, i) => c.from + i)
    const progress = new Progress(boards.length, label)
    let records = 0
    await pool.run(chunked(boards, chunk).map(job), (results) => (records += results.length), (n) => progress.add(n))
    const seconds = progress.finish()
    const perSecond = boards.length / seconds
    console.log(`| ${label} | ${boards.length} | ${seconds.toFixed(1)} | ${perSecond.toFixed(1)} | ${clock(1_000_000 / perSecond)} |`)
    return records
  }
  console.log(`| Pool (${c.threads} threads) | boards | seconds | boards/s | 1,000,000 boards |`)
  console.log('| --- | --- | --- | --- | --- |')
  await measure('DD tables', (boards) => ({ kind: 'tables', seed: c.seed, boards }), 5)
  await measure('Opening leads (TKB auction, every lead solved)', (boards) => ({ kind: 'leads', seed: c.seed, boards, system: c.system, samples: 0 }), 10)
  await measure('Opening leads, 20 sampled layouts each', (boards) => ({ kind: 'leads', seed: c.seed, boards: boards, system: c.system, samples: 20 }), 2)
  await pool.close()
}

async function tables(args: Map<string, string>) {
  const c = common(args)
  const store = await JsonlStore.open<TableRecord>(args.get('out') ?? resolve(DATA_DIR, `tables-${c.seed}.jsonl`))
  const seconds = await runStudy('DD tables', c, store, 5, (boards) => ({ kind: 'tables', seed: c.seed, boards }))
  console.log(`${store.done.size} tables in ${store.path} (${clock(seconds)})`)
}

async function leads(args: Map<string, string>) {
  const c = common(args)
  const samples = Number(args.get('samples') ?? 0)
  if (!Number.isInteger(samples) || samples < 0) throw new Error('--samples must be 0 or a number of layouts')
  const name = `leads-${c.seed}-${c.system}${samples ? `-s${samples}` : ''}-r${rulesFingerprint()}`
  const store = await JsonlStore.open<LeadRecord>(args.get('out') ?? resolve(DATA_DIR, `${name}.jsonl`))
  let seconds = 0
  if (!args.has('analyse')) seconds = await runStudy('Opening leads', c, store, 10, (boards) => ({ kind: 'leads', seed: c.seed, boards, system: c.system, samples }))
  const builder = new LeadStudyBuilder()
  let records = 0
  for await (const record of store.records()) {
    if (covers(c, record.board)) {
      builder.add(record)
      records++
    }
  }
  const report = leadReport(builder.build(), `${c.system}，${c.seed} ${span(c)}${samples ? `，每副抽 ${samples} 個佈局` : ''}${seconds ? `，${clock(seconds)}` : ''}`)
  const file = args.get('report') ?? resolve(DATA_DIR, `${name}.md`)
  writeFileSync(file, report)
  console.log(report)
  console.error(`${records} records → ${file}`)
}

async function compare(args: Map<string, string>) {
  const c = common(args)
  const objective = (args.get('objective') ?? 'score') as Objective
  if (!['score', 'tricks', 'contract'].includes(objective)) throw new Error('--objective is score, tricks or contract')
  const points = (args.get('points') ?? 'all') as CompareOptions['points']
  if (!['lead', 'all', 'defence'].includes(points)) throw new Error('--points is lead, all or defence')
  const options: CompareOptions = { samples: Number(args.get('samples') ?? 30), seed: c.seed, objective, ddBias: Number(args.get('dd-bias') ?? 0), points }
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a number of layouts')
  if (!Number.isFinite(options.ddBias) || options.ddBias < 0) throw new Error('--dd-bias is a number of tricks, 0 or more')
  const name = `compare-${c.seed}-${c.system}-${points}-s${options.samples}-${objective}${options.ddBias ? `-b${options.ddBias}` : ''}-r${rulesFingerprint()}`
  const store = await JsonlStore.open<CompareRecord>(args.get('out') ?? resolve(DATA_DIR, `${name}.jsonl`))
  let seconds = 0
  if (!args.has('analyse')) seconds = await runStudy('TKB vs sampled DD', c, store, 1, (boards) => ({ kind: 'compare', seed: c.seed, boards, system: c.system, options }))
  const records: CompareRecord[] = []
  for await (const record of store.records()) if (covers(c, record.board)) records.push(record)
  const report = compareReport(compareStudy(records, objective), `${c.system}，${c.seed} ${span(c)}，${points === 'lead' ? '只看首攻' : points === 'defence' ? '只看首攻之後的防守' : '每一張牌'}${seconds ? `，${clock(seconds)}` : ''}`, objective)
  const file = args.get('report') ?? resolve(DATA_DIR, `${name}.md`)
  writeFileSync(file, report)
  console.log(report)
  console.error(`${records.length} records → ${file}`)
}

async function replay(args: Map<string, string>) {
  const c = common(args)
  const file = args.get('out')
  if (!file) throw new Error('replay needs --out, the leads file to replay')
  const range = args.has('deals') || c.only ? c : { ...c, deals: Number.MAX_SAFE_INTEGER }
  const store = await JsonlStore.open<LeadRecord>(file)
  const builder = new LeadReplayBuilder()
  const total = [...store.done].filter((n) => covers(range, n)).length
  const pool = await Pool.start(Math.max(1, Math.min(c.threads, total)))
  const progress = new Progress(total, `Replaying the leads (${pool.size} threads)`)
  // A batch at a time, so a million records never sit in memory at once
  const batch: LeadRecord[] = []
  const flush = async () => {
    const leads = new Map<number, Card>()
    const jobs: Job[] = []
    for (let i = 0; i < batch.length; i += 200) jobs.push({ kind: 'replay', seed: c.seed, records: batch.slice(i, i + 200) })
    await pool.run(jobs, (results) => {
      for (const r of results as ReplayResult[]) leads.set(r.board, r.lead)
    }, (n) => progress.add(n))
    for (const record of batch) builder.add(record, leads.get(record.board)!)
    batch.length = 0
  }
  try {
    for await (const record of store.records()) {
      if (!covers(range, record.board)) continue
      batch.push(record)
      if (batch.length >= 20_000) await flush()
    }
    await flush()
  } finally {
    await pool.close()
  }
  const seconds = progress.finish()
  const report = replayReport(builder.build(), `${store.path}，${range === c ? span(c) : '全部'}，${clock(seconds)}`)
  const out = args.get('report') ?? file.replace(/\.jsonl$/, '') + '-replay.md'
  writeFileSync(out, report)
  const changed = args.get('changed')
  if (changed) writeFileSync(changed, builder.changed.join('\n') + '\n')
  console.log(report)
  console.error(`${builder.changed.length} leads changed → ${out}`)
}

/**
 * A practice deal must not teach against the club's handbook: over a preempt it asks for a good
 * suit and 12 points or more (「如何對抗技光」), and since 2026-10-27 the light direct overcall (8–11,
 * five cards not vulnerable, six vulnerable, ROBOT.md §6.8) that TKB now makes itself. A lighter suit
 * bid the simulation likes where TKB still passes is outside both, so it is left out of the club's set
 */
function clubBook(system: string, e: Example): boolean {
  if (system !== 'tku' || e.category !== 'preempt' || !/^[1-7][SHDC]$/.test(e.alternative)) return true
  return hcp(e.hand.split('.').flatMap((ranks, i) => [...ranks].map((r) => SUITS[i] + r))) >= 12
}

/** The bidding study (§7), or with `competitive` only its competitive decisions (`compete`) */
async function bidding(args: Map<string, string>, competitive = false) {
  const c = common(args)
  const competing: BiddingCategory[] = [...COMPETE_CATEGORIES, 'contested']
  const categories = competitive ? competing : CATEGORIES
  const name = `${competitive ? 'compete' : 'bidding'}-${c.seed}-${c.system}-r${rulesFingerprint()}`
  const store = await JsonlStore.open<BiddingRecord>(args.get('out') ?? resolve(DATA_DIR, `${name}.jsonl`))
  let seconds = 0
  const options = competitive ? { categories } : {}
  if (!args.has('analyse')) seconds = await runStudy('Bidding', c, store, 5, (boards) => ({ kind: 'bidding', seed: c.seed, boards, system: c.system, options }))
  const inRange = async function* () {
    for await (const record of store.records()) if (record.board >= c.from && record.board < c.from + c.deals) yield record
  }
  const builder = new BiddingStudyBuilder()
  let records = 0
  for await (const record of inRange()) {
    builder.add(record)
    records++
  }
  const study = builder.build()
  const report = biddingReport(study, `${c.system}，${c.seed} 第 ${c.from}–${c.from + c.deals - 1} 副${seconds ? `，${clock(seconds)}` : ''}`, categories)
  const file = args.get('report') ?? resolve(DATA_DIR, `${name}.md`)
  writeFileSync(file, report)
  console.log(report)
  console.error(`${records} records → ${file}`)
  // --practice dir: this system's deals into dir/bidding.json and dir/competitive.json, the other system's kept
  const practice = args.get('practice')
  if (practice) {
    const all: BiddingRecord[] = []
    for await (const record of inRange()) all.push(record)
    const sets = [
      { file: resolve(practice, 'bidding.json'), categories: CONSTRUCTIVE as readonly BiddingCategory[] },
      { file: resolve(practice, 'competitive.json'), categories: competing },
    ]
    for (const set of sets) {
      if (!set.categories.some((cat) => categories.includes(cat))) continue
      const kept = existsSync(set.file) ? (JSON.parse(readFileSync(set.file, 'utf8')) as PracticeDeal[]).filter((d) => d.system !== c.system) : []
      const deals = practiceDeals(all, (board) => evalBoard(board, c.seed).hands, study, set.categories, 40, 5, 20, (e) => clubBook(c.system, e))
      if (!kept.length && !deals.length) continue
      writeFileSync(set.file, JSON.stringify([...kept, ...deals], null, 2) + '\n')
      console.error(`${deals.length} practice deals → ${set.file}`)
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = readArgs(rest)
  if (!command || command === 'help' || args.has('help')) {
    console.log(USAGE)
    return
  }
  const commands: Record<string, (args: Map<string, string>) => Promise<void>> = { bench, tables, leads, compare, replay, bidding: (a) => bidding(a), compete: (a) => bidding(a, true) }
  const run = commands[command]
  if (!run) throw new Error(`unknown command "${command}"`)
  await run(args)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  console.error(USAGE)
  process.exit(2)
})
