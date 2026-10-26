/**
 * npm run load -- --url <site> [--users 30] [--tables 5] [--robot-tables 2] [--watchers 6]
 *   [--minutes 5] [--think 2000] [--lobby-every 60] [--churn 0] [--challenge 0] [--out file.json] [--dry-run]
 *
 * Simulated members against a local `wrangler dev`, staging or a PR preview, never production
 * (docs/LOAD.md). Accounts are `load001`… made through the admin API by the site's first account
 * (`--admin`, default `admin`, registered when the site is empty). The password and invite code
 * come from LOAD_PASSWORD and LOAD_INVITE_CODE (kept out of the shell history). A remote run is
 * refused when its estimate is over 15% of any of the free plan's daily allowances (budget.ts)
 */
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Seat } from '../../shared/cards.ts'
import { checkTarget } from '../seed.ts'
import { describe, estimate, measured, RUN_SHARE, worstShare, type Plan } from './budget.ts'
import { SimUser } from './client.ts'
import { latencyTable, Recorder } from './stats.ts'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    admin: { type: 'string', default: 'admin' },
    prefix: { type: 'string', default: 'load' },
    users: { type: 'string', default: '30' },
    tables: { type: 'string', default: '5' },
    'robot-tables': { type: 'string', default: '2' },
    watchers: { type: 'string', default: '6' },
    minutes: { type: 'string', default: '5' },
    think: { type: 'string', default: '2000' },
    'lobby-every': { type: 'string', default: '60' },
    churn: { type: 'string', default: '0' },
    challenge: { type: 'string', default: '0' },
    out: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
})

const password = process.env.LOAD_PASSWORD ?? ''
if (!values.url || password.length < 6) {
  console.error('Usage: LOAD_PASSWORD=... [LOAD_INVITE_CODE=...] npm run load -- --url <site> [options] (see scripts/load/cli.ts)')
  process.exit(2)
}
const origin = checkTarget(values.url)
const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)
const tables = Number(values.tables)
const robotTables = Math.min(tables, Number(values['robot-tables']))
const plan: Plan = {
  users: Number(values.users),
  humanTables: tables - robotTables,
  robotTables,
  watchers: Number(values.watchers),
  minutes: Number(values.minutes),
  thinkMs: Number(values.think),
  lobbyEverySeconds: Number(values['lobby-every']),
  churn: Number(values.churn),
  challengePlayers: Number(values.challenge),
}
const seated = plan.humanTables * 4 + plan.robotTables
if (seated + plan.watchers + plan.challengePlayers > plan.users) {
  console.error(`Not enough members: ${seated} seated + ${plan.watchers} watching + ${plan.challengePlayers} in the challenge > ${plan.users}`)
  process.exit(2)
}
const expected = estimate(plan)
console.log(`Plan: ${JSON.stringify(plan)}`)
console.log(`Estimate: ${describe(expected)}  ${JSON.stringify(expected.detail)}`)
if (!local && worstShare(expected) > RUN_SHARE) {
  console.error(`Refusing: over ${RUN_SHARE * 100}% of a day's free allowance, shared with production. Make the run smaller`)
  process.exit(3)
}
if (values['dry-run']) process.exit(0)

const recorder = new Recorder()
const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`)
const site = { origin, recorder, thinkMs: plan.thinkMs, random: Math.random, log }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs `work` over `items`, `width` at a time */
async function pool<T>(items: T[], width: number, work: (item: T, index: number) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        await work(items[index], index)
      }
    }),
  )
}

// ── Accounts ──────────────────────────────────────────────────────────────────────────────────
const admin = new SimUser(values.admin, password, site)
const founded = await admin.http<{ code?: string }>('POST', '/api/register', { username: values.admin, password, inviteCode: process.env.LOAD_INVITE_CODE ?? '' }, 'register')
if (founded.status === 202) throw new Error(`${values.admin} is not the site's first account: pass the admin's name with --admin`)
await admin.login()
const names = Array.from({ length: plan.users - 1 }, (_, i) => `${values.prefix}${String(i + 1).padStart(3, '0')}`)
let created = 0
await pool(names, 4, async (username) => {
  const { status, data } = await admin.http<{ code?: string }>('POST', '/api/admin/users', { username, password }, 'createUser')
  if (status === 200) created++
  else if (data.code !== 'usernameTaken') throw new Error(`Adding ${username}: ${status} ${data.code ?? ''}`)
})
log(`accounts: ${created} created, ${names.length - created} already there`)
const users = [admin, ...names.map((name) => new SimUser(name, password, site))]
await pool(users.slice(1), 8, (user) => user.login())
await pool(users, 16, (user) => user.connect())
log(`${users.length} members connected`)

const health = async () => (await admin.http<Record<string, unknown>>('GET', '/api/health', undefined, 'health')).data
const healthBefore = await health()

// ── Tables ────────────────────────────────────────────────────────────────────────────────────
let cursor = 0
const take = (n: number) => users.slice(cursor, (cursor += n))
const tableIds: string[] = []
const others: Seat[] = ['N', 'E', 'W']
let seatChanges = 0
for (let t = 0; t < plan.humanTables; t++) {
  const [host, ...rest] = take(4)
  const tableId = await host.createTable()
  if (!tableId) throw new Error(`${host.username} could not open a table`)
  tableIds.push(tableId)
  await Promise.all(rest.map((user, i) => user.sit(tableId, others[i])))
  for (const user of [host, ...rest]) user.autoplay = true
  host.countRobots = true
  seatChanges += 4
}
for (let t = 0; t < plan.robotTables; t++) {
  const [host] = take(1)
  const tableId = await host.createTable()
  if (!tableId) throw new Error(`${host.username} could not open a table`)
  tableIds.push(tableId)
  for (const seat of others) await host.addRobot(seat)
  host.autoplay = true
  host.countRobots = true
  seatChanges += 4
}
const challengers = take(plan.challengePlayers)
const watchers = take(plan.watchers)
await pool(watchers, 8, async (user, i) => {
  await user.watch(tableIds[i % tableIds.length])
  seatChanges++
})
const lobby = users.slice(cursor)
// Kick the first turn: whoever is to act already has the table
for (const user of users) if (user.autoplay) user.nudge()
log(`${tableIds.length} tables, ${watchers.length} watching, ${lobby.length} in the lobby, ${challengers.length} in a challenge`)

// ── The run ───────────────────────────────────────────────────────────────────────────────────
const started = Date.now()
const until = started + plan.minutes * 60_000
const timers: ReturnType<typeof setInterval>[] = []
const snapshots: Record<string, unknown>[] = []

// Lobby members: a history page, their own page, or a direct message, every lobby-every seconds
for (const user of lobby) {
  const act = async () => {
    const roll = Math.random()
    if (roll < 0.34) await user.http('GET', '/api/history?scope=all&page=1&size=20').catch(() => {})
    else if (roll < 0.67) await user.http('GET', '/api/me').catch(() => {})
    else {
      const other = lobby[Math.floor(Math.random() * lobby.length)]
      if (other !== user && other.id) await user.direct(other.id, `load ${Date.now()}`)
    }
  }
  const every = plan.lobbyEverySeconds * 1000
  setTimeout(() => timers.push(setInterval(() => void act(), every)), Math.random() * every)
}
// Now and then a line in the table chat
timers.push(
  setInterval(() => {
    const players = users.filter((u) => u.autoplay)
    const user = players[Math.floor(Math.random() * players.length)]
    if (user) void user.chat(`hi ${Date.now() % 10000}`)
  }, 20_000),
)
// Members dropping their connection and coming back (a phone losing signal)
if (plan.churn > 0)
  timers.push(
    setInterval(() => {
      for (const user of users) if (user !== admin && Math.random() < plan.churn) user.drop()
    }, 30_000),
  )
timers.push(setInterval(() => void health().then((h) => snapshots.push({ at: Date.now() - started, ...h })), 60_000))

// The challenge (H2b, EventObject): one board each, started at once, finished early by the last one
let challengeReport: Record<string, unknown> | null = null
const runChallenge = async () => {
  const [creator, ...invited] = challengers
  for (const user of invited) await creator.follow(user.id)
  const at = Date.now()
  const made = await creator.http<{ challenge?: { id: string } }>('POST', '/api/challenges', { invitees: invited.map((u) => u.id), boards: 1, settings: { days: 1 } }, 'createChallenge')
  const id = made.data.challenge?.id
  if (!id) return void (challengeReport = { error: `create ${made.status} ${made.data.code ?? ''}` })
  await Promise.all(invited.map((user) => user.http('POST', `/api/challenges/${id}/answer`, { accept: true }, 'answerChallenge')))
  const afterCreate = await health()
  await Promise.all(
    challengers.map(async (user) => {
      user.autoplay = true
      await user.playChallenge(id)
      user.nudge()
    }),
  )
  let status = ''
  let detail: { challenge?: { status: string; players: unknown[]; standings?: unknown } } = {}
  while (Date.now() < until + 120_000) {
    detail = (await creator.http<typeof detail>('GET', `/api/challenges/${id}`, undefined, 'challengeDetail')).data
    status = detail.challenge?.status ?? '?'
    if (status === 'finished' || status === 'cancelled' || status === 'expired') break
    await sleep(10_000)
  }
  const settledIn = Date.now() - at
  for (const user of challengers) {
    user.autoplay = false
    await user.leave()
  }
  challengeReport = { id, status, settledInSeconds: Math.round(settledIn / 1000), standings: !!detail.challenge?.standings, eventsAfterCreate: afterCreate.events, eventsAfterEnd: (await health()).events }
  log(`challenge ${id}: ${status} after ${Math.round(settledIn / 1000)} s`)
}
const challengeDone = challengers.length >= 2 ? runChallenge() : Promise.resolve()

while (Date.now() < until) {
  await sleep(Math.min(30_000, until - Date.now()))
  const boards = recorder.get('boards')
  log(`${Math.round((Date.now() - started) / 1000)} s: ${recorder.get('sent')} sent, ${boards} boards, ${recorder.get('reconnect')} reconnects`)
}
await challengeDone
for (const timer of timers) clearInterval(timer)
for (const user of users) user.autoplay = false
await pool(users, 16, async (user) => void (await user.leave()))
const healthAfter = await health()
for (const user of users) user.stop()

// ── Report ────────────────────────────────────────────────────────────────────────────────────
const minutes = (Date.now() - started) / 60_000
const counts = Object.fromEntries([...recorder.counts].sort(([a], [b]) => a.localeCompare(b)))
const used = measured({
  http: recorder.get('http'),
  upgrades: recorder.get('upgrade:club') + recorder.get('upgrade:table'),
  tableUpgrades: recorder.get('upgrade:table'),
  sent: recorder.get('sent'),
  pings: recorder.get('ping'),
  robotMoves: recorder.get('robotMoves'),
  boards: recorder.get('boards'),
  seatChanges,
  minutes,
  robotTables: plan.robotTables,
  humanTables: plan.humanTables,
})
const latency = recorder.latency()
const report = { origin, plan, minutes: Math.round(minutes * 10) / 10, estimate: expected, used, latency, counts, challenge: challengeReport, healthBefore, healthAfter, snapshots }
console.log('\n' + latencyTable(latency))
console.log(`\nCounts: ${JSON.stringify(counts)}`)
console.log(`Used (from the run's counts): ${describe(used)}`)
console.log(`Challenge: ${JSON.stringify(challengeReport)}`)
console.log(`Health after: ${JSON.stringify(healthAfter)}`)
if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))
process.exit(0)
