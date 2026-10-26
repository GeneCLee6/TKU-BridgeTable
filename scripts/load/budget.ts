/**
 * What a load run costs of the free plan's daily allowance (docs/LOAD.md §2), before it runs
 * (`estimate`, from the plan) and after (`measured`, from what the run counted). The preview,
 * staging and production share one Cloudflare account and so one allowance: a run against a
 * remote site must stay under RUN_SHARE of it, and a day's runs under DAY_SHARE.
 *
 * The billing units (Cloudflare's free plan, 2026-10):
 * - Workers: 100,000 requests a day. Every HTTP request and every WebSocket upgrade is one;
 *   messages on an open WebSocket are not (they go to the Durable Object)
 * - Durable Objects: 100,000 requests a day. Every request the Worker forwards (HTTP, upgrade),
 *   every RPC call between objects, every alarm, and every 20 WebSocket messages received (20:1);
 *   the pings browsers send (`ping`, answered by the runtime) are counted too, to be safe
 * - Durable Objects duration: 13,000 GB-s a day; an object is billed 128 MB for the time it is
 *   awake. A table with robots never sleeps while it plays; one with only people sleeps between moves
 */

export const DAILY = { workerRequests: 100_000, doRequests: 100_000, doGbSeconds: 13_000 }
/** The most one remote run may use of each daily allowance, and all of a day's runs together */
export const RUN_SHARE = 0.15
export const DAY_SHARE = 0.3

/** Robot timing (worker/table-service.ts ROBOT_DELAY) and the browser's ping (src/lib/liveSocket.ts) */
const ROBOT_MS = { call: 600, card: 1050, afterTrick: 2300 }
const DEAL_GAP_MS = 2700 + 2300
const PING_EVERY_MS = 15_000
const CALLS_PER_BOARD = 9

export interface Plan {
  users: number
  /** Tables of four people */
  humanTables: number
  /** Tables of one person and three TKB */
  robotTables: number
  watchers: number
  minutes: number
  /** How long a simulated person thinks per call or card, on average (ms) */
  thinkMs: number
  /** Per lobby member, one HTTP page or direct message every this many seconds */
  lobbyEverySeconds: number
  /** The share of members who drop and reconnect every 30 s */
  churn: number
  /** People in a one-board challenge run alongside (EventObject), 0 for none */
  challengePlayers: number
}

export interface Usage {
  workerRequests: number
  doRequests: number
  doGbSeconds: number
}

/** How long one board takes at each kind of table (ms), and how many robot moves it has */
export function boardTimes(thinkMs: number) {
  const human = CALLS_PER_BOARD * thinkMs + 52 * thinkMs + DEAL_GAP_MS
  // One person among three robots: a quarter of the calls, 13 cards and (half the time) dummy's
  const personMoves = CALLS_PER_BOARD / 4 + 13 + 6.5
  const robotMoves = CALLS_PER_BOARD + 52 - personMoves
  const robot =
    personMoves * thinkMs + (CALLS_PER_BOARD * 0.75) * ROBOT_MS.call + (52 - 19.5 - 9) * ROBOT_MS.card + 9 * ROBOT_MS.afterTrick + DEAL_GAP_MS
  return { human, robot, robotMoves, personMoves }
}

export function estimate(plan: Plan): Usage & { detail: Record<string, number> } {
  const minutes = plan.minutes
  const ms = minutes * 60_000
  const times = boardTimes(plan.thinkMs)
  const humanBoards = (plan.humanTables * ms) / times.human
  const robotBoards = (plan.robotTables * ms) / times.robot
  const boards = humanBoards + robotBoards
  const seated = plan.humanTables * 4 + plan.robotTables
  const tableSockets = seated + plan.watchers + plan.challengePlayers
  const sockets = plan.users + tableSockets
  // People's moves, over their table socket
  const moves = humanBoards * (CALLS_PER_BOARD + 52) + robotBoards * times.personMoves + plan.challengePlayers * 20
  const pings = (sockets * ms) / PING_EVERY_MS
  const lobby = Math.max(0, plan.users - seated - plan.watchers - plan.challengePlayers)
  const lobbyActions = (lobby * ms) / (plan.lobbyEverySeconds * 1000)
  const reconnects = plan.churn * plan.users * (ms / 30_000)
  // Signing in and the two connections, then each reconnect opens them again; setting up tables
  const http = plan.users * 2 + lobbyActions / 2 + plan.challengePlayers * 3 + minutes * 2
  const upgrades = sockets + reconnects * 2
  const robotAlarms = robotBoards * times.robotMoves + plan.challengePlayers * 45
  const dealAlarms = boards + plan.challengePlayers
  // Table → club: the lobby entry when a board is dealt and finished, the record; club → table per seat change
  const rpc = boards * 3 + seated * 2 + plan.watchers + plan.challengePlayers * 6 + reconnects
  const received = moves + pings + lobbyActions / 2 + plan.users * 3
  const workerRequests = http + upgrades
  const doRequests = http + upgrades + tableSockets + reconnects + rpc + robotAlarms + dealAlarms + received / 20
  // Awake: the club the whole time, a robot table the whole time, a people's table a third of it
  const awakeSeconds = (ms / 1000) * (1 + plan.robotTables + plan.humanTables / 3 + Math.min(plan.challengePlayers, 1) * 0.2)
  const doGbSeconds = awakeSeconds * 0.128
  return {
    workerRequests: Math.ceil(workerRequests),
    doRequests: Math.ceil(doRequests),
    doGbSeconds: Math.ceil(doGbSeconds),
    detail: {
      boards: Math.round(boards),
      peopleMoves: Math.round(moves),
      robotAlarms: Math.round(robotAlarms),
      pings: Math.round(pings),
      http: Math.round(http),
      upgrades: Math.round(upgrades),
      rpc: Math.round(rpc),
    },
  }
}

/** What a finished run used, from its own counts (the robots' moves and the deals from the boards seen) */
export function measured(counts: {
  http: number
  upgrades: number
  tableUpgrades: number
  sent: number
  pings: number
  robotMoves: number
  boards: number
  seatChanges: number
  minutes: number
  robotTables: number
  humanTables: number
}): Usage {
  const rpc = counts.boards * 3 + counts.seatChanges
  const received = counts.sent + counts.pings
  return {
    workerRequests: counts.http + counts.upgrades,
    doRequests: Math.ceil(counts.http + counts.upgrades + counts.tableUpgrades + rpc + counts.robotMoves + counts.boards + received / 20),
    doGbSeconds: Math.ceil(counts.minutes * 60 * (1 + counts.robotTables + counts.humanTables / 3) * 0.128),
  }
}

export function shareOf(usage: Usage) {
  return {
    workerRequests: usage.workerRequests / DAILY.workerRequests,
    doRequests: usage.doRequests / DAILY.doRequests,
    doGbSeconds: usage.doGbSeconds / DAILY.doGbSeconds,
  }
}

/** The largest share of any allowance; a remote run is refused above RUN_SHARE */
export const worstShare = (usage: Usage) => Math.max(...Object.values(shareOf(usage)))

export function describe(usage: Usage): string {
  const share = shareOf(usage)
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`
  return [
    `Workers requests ${usage.workerRequests} (${pct(share.workerRequests)} of a day)`,
    `Durable Object requests ${usage.doRequests} (${pct(share.doRequests)})`,
    `Durable Object duration ${usage.doGbSeconds} GB-s (${pct(share.doGbSeconds)})`,
  ].join('; ')
}
