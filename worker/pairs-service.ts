import type { RandomInt } from '../shared/board.ts'
import { makeDealSet } from '../shared/deal-set.ts'
import { mitchell, MOVEMENT_PAIRS } from '../shared/movement.ts'
import { parsePairsSettings, scorePairs, type PairsScoringOptions, type PairsSettings, type PairsSummary, type PairsView } from '../shared/pairs.ts'
import type { PublicUser, RobotSpeed } from '../shared/protocol.ts'
import { delayOf, type RefereeEntry } from '../shared/referee.ts'
import type { ScoreRuling } from '../shared/ruling-scoring.ts'
import { AppError } from '../shared/messages.ts'
import { ClubError } from './errors.ts'
import { crashEntry, type Logger } from './log.ts'
import type { EventReport } from './modes.ts'
import { LocalPairs, type PairsApi, type PairsSnapshot, type RemotePairs } from './pairs-events.ts'
import { boardsLeft, nextRoundDue, pairOf, pairsPlayers, type PairsEvent, type PairsStep } from './pairs-flow.ts'
import { pairsTable } from './pairs-mode.ts'
import type { RankedEvent } from './rankings.ts'
import type { Store } from './store.ts'
import type { Table } from './views.ts'
import { pairsScoring, pairsSummary, pairsView, type PairsDirecting } from './views.ts'

/**
 * Pairs events, the club's half (`e9-t10`–`e9-t13`, ARCHITECTURE.md §5.22): the checks only the
 * club can make (members, blocks, who is online, who plays elsewhere), the tables of each round,
 * and every page. The event's own state changes in `pairs-flow.ts` where it lives (its own
 * `EventObject` with `EVENT_OBJECTS=on` when it was created, else the club's storage); the club
 * keeps a copy of each (`pairsev:<id>`), and reads only that. Like `TeamMatchService` it touches
 * no Cloudflare API: the tables come through the deps.
 */

/** What the club keeps of an event: the copy, where it lives, and what the club already did about its end */
interface PairsCopy {
  event: PairsEvent
  rev: number
  home: 'club' | 'object'
  /** The end was closed up (its tables told, its records shown to everyone) */
  settled?: boolean
}

const KEY = 'pairsev:'

export interface PairsServiceDeps {
  store: Store
  now: () => number
  newId: () => string
  random: RandomInt
  log: Logger
  userById: (id: string) => PublicUser | null
  userByName: (username: string) => string | null
  blocked: (by: string, other: string) => boolean
  online: () => string[]
  /** The member has the `pairs` feature flag */
  featureOn: (userId: string) => boolean
  takeAction: (userId: string) => boolean
  /** A member as a table needs them */
  person: (userId: string) => { username: string; blocked: string[]; robotSpeed?: RobotSpeed }
  /** Plays in a team match being played */
  inMatch: (userId: string) => boolean
  openTable: (table: Table) => Promise<void>
  /** The table's round ended: nothing more is dealt, and it closes once its people leave */
  endTable: (tableId: string) => Promise<void>
  closeTable: (tableId: string) => Promise<void>
  leave: (userId: string) => Promise<void>
  /** Shows every record of the event to everyone (`revealEvent`) */
  reveal: (eventId: string) => Promise<void>
  /** Writes a finished event into the points ledger and the ratings (J2, `RankingsService.record`; once per event there) */
  ranked: (event: RankedEvent) => void
  /** The member acts as an admin (`actsAsAdmin`): they may direct any event (`e9-t17`) */
  isAdmin: (userId: string) => boolean
  /** The director's log of an event (`worker/referee.ts`) */
  refereeOf: (eventId: string) => readonly RefereeEntry[]
  /** The rulings on an event's board records (`e2-t35`, the history index's `board_rulings`) */
  rulingsOf: (eventId: string) => (boardId: string) => ScoreRuling | undefined
  /** The events' own objects, when configured */
  objects?: RemotePairs
  /** New events go into their own objects (`EVENT_OBJECTS=on`) */
  objectsOn: boolean
}

export class PairsService {
  private readonly deps: PairsServiceDeps
  private readonly copies = new Map<string, PairsCopy>()
  private readonly local: LocalPairs
  /** One round change (or close-up) at a time per event: results from several tables come together */
  private readonly lanes = new Map<string, Promise<void>>()

  constructor(deps: PairsServiceDeps) {
    this.deps = deps
    this.local = new LocalPairs({
      get: (id) => {
        const copy = this.copies.get(id)
        return copy ? { event: copy.event, rev: copy.rev } : null
      },
      now: deps.now,
    })
    if (deps.objects)
      deps.objects.attach = {
        snapshot: (snapshot) => void this.apply(snapshot),
        copy: (id) => this.copies.get(id)?.event ?? null,
      }
  }

  async load() {
    for (const copy of (await this.deps.store.list<PairsCopy>(KEY)).values()) this.copies.set(copy.event.id, copy)
    // A round change or close-up cut short by an eviction is picked up again
    for (const id of this.copies.keys()) void this.progress(id)
  }

  /** The event, where it lives */
  private api(id: string): PairsApi {
    const copy = this.copies.get(id)
    return copy?.home === 'object' && this.deps.objects ? this.deps.objects.get(id) : this.local.get(id)
  }

  /** An event as it answered or reported: written over the copy unless the copy is newer */
  private async apply({ event, rev }: PairsSnapshot) {
    const known = this.copies.get(event.id)
    if (!known || rev <= known.rev) return
    const copy = { ...known, event, rev }
    this.copies.set(event.id, copy)
    await this.deps.store.put(KEY + event.id, copy)
  }

  /** What an event in its own object tells the club again (`EventLink.pairsChanged`) */
  async changed(snapshot: PairsSnapshot) {
    await this.apply(snapshot)
    await this.progress(snapshot.event.id)
  }

  private async step(id: string, step: PairsStep): Promise<PairsEvent> {
    const snapshot = await this.api(id).step(step)
    await this.apply(snapshot)
    return this.copies.get(id)!.event
  }

  private require(id: unknown): PairsEvent {
    const copy = typeof id === 'string' ? this.copies.get(id) : undefined
    if (!copy) throw new ClubError('pairsGone', {}, 404)
    return copy.event
  }

  /**
   * The member has the `pairs` flag, or is in the event or directs it: an event made from a
   * tournament's entries (`e9-t16`, §5.24) is played by members who may not have the flag
   */
  private allowed(userId: string, event?: PairsEvent) {
    if (this.deps.featureOn(userId)) return
    if (event && (event.directorId === userId || pairOf(event, userId) >= 0)) return
    throw new ClubError('pairsOff', {}, 403)
  }

  private limited(userId: string) {
    if (!this.deps.takeAction(userId)) throw new ClubError('slowDown', {}, 429)
  }

  // ── Pages ─────────────────────────────────────────────────────────────────────────────────

  /** `GET /api/pairs`: the events, newest first; cancelled ones only to their director */
  list(userId: string): PairsSummary[] {
    this.allowed(userId)
    return [...this.copies.values()]
      .map((c) => c.event)
      .filter((e) => e.status !== 'cancelled' || e.directorId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => pairsSummary(e, userId, this.deps.userById))
  }

  /** `GET /api/pairs/:id`: the event as the member may see it (`views.ts` `pairsView`) */
  view(id: string, userId: string): PairsView {
    const event = this.require(id)
    this.allowed(userId, event)
    void this.progress(event.id)
    return pairsView(event, userId, this.deps.userById, this.directing(event.id, userId))
  }

  /** What the page and the scoring need of the director's work (`e9-t17`) */
  private directing(id: string, userId?: string): PairsDirecting {
    return {
      ...(userId !== undefined && { admin: this.deps.isAdmin(userId) }),
      entries: this.deps.refereeOf(id),
      rulingOf: this.deps.rulingsOf(id),
    }
  }

  /**
   * The table a member plays at in an event being played (`checkNotInMatch`): the round's table,
   * '' while their pair sits out or waits for the next round, null when they play in none
   */
  tableOf(userId: string): string | null {
    for (const { event } of this.copies.values()) {
      if (event.status !== 'playing') continue
      const pair = pairOf(event, userId)
      if (pair < 0) continue
      const round = event.movement!.schedule[event.round - 1]
      const table = round?.tables.find((t) => t.ns === pair || t.ew === pair)
      return (table && event.roundTables[event.round - 1]?.[table.table - 1]) || ''
    }
    return null
  }

  // ── Setting up (`e9-t10`) ────────────────────────────────────────────────────────────────

  /** `POST /api/pairs { settings }`: a new event; whoever creates it directs it */
  async create(userId: string, settings: unknown): Promise<PairsView> {
    this.allowed(userId)
    this.limited(userId)
    const parsed = parsePairsSettings(settings)
    if (!parsed) throw new ClubError('badPairsSettings')
    const event = await this.open(userId, parsed)
    return this.view(event.id, userId)
  }

  /**
   * A tournament's pairs event (`e9-t16`, §5.24): made by the admin who starts the tournament (its
   * director) with the tournament's settings, and its pairs entered in order. The tournament
   * already checked the flag, the partners and the blocks; the director starts it on its page
   */
  async createFrom(directorId: string, settings: PairsSettings, pairs: [string, string][]): Promise<string> {
    const event = await this.open(directorId, settings)
    for (const players of pairs) await this.step(event.id, { kind: 'enter', players, at: this.deps.now() })
    return event.id
  }

  /** A new event, its copy kept and its home (the club or its own object) chosen */
  private async open(userId: string, settings: PairsSettings): Promise<PairsEvent> {
    const event: PairsEvent = {
      id: this.deps.newId(),
      directorId: userId,
      createdAt: this.deps.now(),
      status: 'open',
      settings,
      pairs: [],
      round: 0,
      roundTables: [],
      results: [],
    }
    const home = this.deps.objects && this.deps.objectsOn ? 'object' : 'club'
    // The copy first, so the club reaches the event where it lives from now on; an object that did
    // not answer adopts the copy at the first step (`RemotePairs`)
    const copy: PairsCopy = { event, rev: 0, home }
    this.copies.set(event.id, copy)
    await this.deps.store.put(KEY + event.id, copy)
    try {
      await this.apply(await this.api(event.id).adopt(event))
    } catch (error) {
      this.deps.log(crashEntry('adoptPairs', error))
    }
    return event
  }

  /** An event's state for a tournament made from it (`e9-t16`); null when there is none */
  statusOf(id: string): PairsEvent['status'] | null {
    return this.copies.get(id)?.event.status ?? null
  }

  /** `POST /api/pairs/:id/enter { partner }`: the member and a partner (by username) enter as a pair */
  async enter(userId: string, id: string, partner: unknown): Promise<PairsView> {
    this.allowed(userId)
    this.limited(userId)
    const event = this.require(id)
    if (event.status !== 'open') throw new ClubError('pairsNotOpen')
    const partnerId = typeof partner === 'string' ? this.deps.userByName(partner.trim()) : null
    if (!partnerId || partnerId === userId || this.deps.blocked(userId, partnerId) || this.deps.blocked(partnerId, userId))
      throw new ClubError('pairsBadPartner')
    for (const id of [userId, partnerId])
      if (pairOf(event, id) >= 0) throw new ClubError('pairsInPair', { name: this.deps.userById(id)?.username ?? '' })
    await this.step(event.id, { kind: 'enter', players: [userId, partnerId], at: this.deps.now() })
    return this.view(event.id, userId)
  }

  /** `POST /api/pairs/:id/withdraw { userId? }`: a pair leaves (one of its players, or the director for any pair) */
  async withdraw(userId: string, id: string, who: unknown): Promise<PairsView> {
    const event = this.require(id)
    this.allowed(userId, event)
    this.limited(userId)
    const target = typeof who === 'string' && who ? who : userId
    await this.step(event.id, { kind: 'withdraw', userId: target, by: userId })
    return this.view(event.id, userId)
  }

  /** `POST /api/pairs/:id/cancel`: the director calls it off before the start */
  async cancel(userId: string, id: string): Promise<PairsView> {
    const event = this.require(id)
    this.allowed(userId, event)
    this.limited(userId)
    await this.step(event.id, { kind: 'cancel', userId, at: this.deps.now() })
    return this.view(event.id, userId)
  }

  // ── Playing (`e9-t11`) ───────────────────────────────────────────────────────────────────

  /**
   * `POST /api/pairs/:id/start`: the director starts it with 5–20 pairs, everyone online and
   * playing nowhere else. The movement is worked out (Mitchell, `shared/movement.ts`), one deal set
   * is dealt for the whole event, everyone leaves the table they are at, and the first round's
   * tables open together. If one cannot open, those opened close and the event stays open
   */
  async start(userId: string, id: string): Promise<PairsView> {
    const event = this.require(id)
    this.allowed(userId, event)
    this.limited(userId)
    if (event.directorId !== userId) throw new ClubError('pairsDirectorOnly', {}, 403)
    if (event.status !== 'open') throw new ClubError('pairsNotOpen')
    // The director put the start off (`e9-t17`): not before then
    const until = delayOf(this.deps.refereeOf(event.id))
    if (until !== null && until > this.deps.now())
      throw new ClubError('eventDelayed', { minutes: Math.ceil((until - this.deps.now()) / 60_000) })
    const movement = mitchell(event.pairs.length, event.settings.boardsPerRound)
    if (!movement) throw new ClubError(event.pairs.length < MOVEMENT_PAIRS.min ? 'pairsTooFew' : 'pairsFull', { min: MOVEMENT_PAIRS.min, max: MOVEMENT_PAIRS.max })
    const online = new Set(this.deps.online())
    for (const player of pairsPlayers(event)) {
      const name = this.deps.userById(player)?.username ?? ''
      if (!online.has(player)) throw new ClubError('pairsOffline', { name })
      if (this.deps.inMatch(player) || this.tableOf(player) !== null) throw new ClubError('pairsPlayerBusy', { name })
    }
    const deals = makeDealSet({ kind: 'random', count: movement.boards }, this.deps.random)
    if (!deals) throw new ClubError('serverError', {}, 500)
    const started: PairsEvent = { ...event, movement, deals, round: 1 }
    for (const player of pairsPlayers(event)) await this.deps.leave(player)
    const tables = await this.openRound(started, 1)
    try {
      await this.step(event.id, { kind: 'start', userId, deals, tables, at: this.deps.now() })
    } catch (error) {
      // The event did not take the start: it stays open, and the tables close
      if (this.copies.get(event.id)?.event.status === 'open')
        for (const tableId of tables) if (tableId) await this.deps.closeTable(tableId).catch(() => undefined)
      throw error instanceof AppError ? error : new ClubError('serverError', {}, 500)
    }
    return this.view(event.id, userId)
  }

  /** Opens a round's tables together (the movement says who and which boards); '' for a table that sits out */
  private async openRound(event: PairsEvent, round: number): Promise<string[]> {
    const movement = event.movement!
    const schedule = movement.schedule[round - 1]
    const ids = Array.from({ length: movement.tables }, () => '')
    for (const t of schedule.tables) ids[t.table - 1] = this.deps.newId()
    const opened = await Promise.allSettled(
      schedule.tables.map((t) => this.deps.openTable(this.tableOfRound(event, round, t.table, ids[t.table - 1], t.boards))),
    )
    const failed = opened.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      for (const [i, result] of opened.entries())
        if (result.status === 'fulfilled') await this.deps.closeTable(ids[schedule.tables[i].table - 1]).catch(() => undefined)
      throw failed.reason instanceof AppError ? failed.reason : new ClubError('serverError', {}, 500)
    }
    return ids
  }

  /** One table of a round as it opens, playing `boards` (the round's there, or what is left of them) */
  private tableOfRound(event: PairsEvent, round: number, table: number, id: string, boards: number[]): Table {
    const movement = event.movement!
    const t = movement.schedule[round - 1].tables.find((x) => x.table === table)!
    const players = pairsPlayers(event)
    return pairsTable({
      id,
      eventId: event.id,
      directorId: event.directorId,
      round,
      rounds: movement.rounds,
      table,
      ns: event.pairs[t.ns].players,
      ew: event.pairs[t.ew].players,
      nsPair: t.ns,
      ewPair: t.ew,
      boards,
      deals: event.deals!,
      boardMinutes: event.settings.boardMinutes,
      players,
      now: this.deps.now(),
      people: Object.fromEntries(players.map((p) => [p, this.deps.person(p)])),
    })
  }

  // ── The director's tools (`e9-t17`; the log and the audit are the club's, `ClubService.referee`) ──

  /** The event, for one of the director's tools: its director or an admin */
  requireReferee(userId: string, id: unknown): PairsEvent {
    const event = this.require(id)
    if (event.directorId !== userId && !this.deps.isAdmin(userId)) throw new ClubError('refereeOnly', {}, 403)
    return event
  }

  /**
   * A score for a board a table of the round has not played (a table held the round up), or one
   * given so taken back; the round moves on when that was the last board it waited for
   */
  async assign(id: string, request: { round?: number; table: number; boardNo: number; ruling: ScoreRuling | null }) {
    const event = this.require(id)
    const round = request.round ?? event.round
    await this.step(id, { kind: 'assign', round, table: request.table, boardNo: request.boardNo, ruling: request.ruling, at: this.deps.now() })
    await this.progress(id)
    return { round }
  }

  /**
   * Re-opens a table of the round: the table closes (the board on it is not kept), its four players
   * leave it, and a new one opens for the boards there with no result yet and those in `replay`
   * (played there, played again: their results are dropped). One at a time with the round changes
   */
  restart(id: string, table: number, replay: number[]): Promise<{ round: number }> {
    return this.lane(id, async () => {
      const event = this.require(id)
      if (event.status !== 'playing' || !event.movement) throw new ClubError('pairsNotPlaying')
      const round = event.round
      const t = event.movement.schedule[round - 1]?.tables.find((x) => x.table === table)
      if (!t || !replay.every((b) => t.boards.includes(b))) throw new ClubError('refereeNoBoard', {}, 404)
      const left = new Set(boardsLeft(event, round, table))
      const boards = t.boards.filter((b) => left.has(b) || replay.includes(b))
      if (!boards.length) throw new ClubError('refereeNothingLeft')
      const old = event.roundTables[round - 1]?.[table - 1]
      if (old) await this.deps.closeTable(old).catch(() => undefined)
      for (const player of [...event.pairs[t.ns].players, ...event.pairs[t.ew].players]) await this.deps.leave(player)
      const tableId = this.deps.newId()
      await this.deps.openTable(this.tableOfRound(event, round, table, tableId, boards))
      try {
        await this.step(id, { kind: 'retable', round, table, tableId, replay })
      } catch (error) {
        await this.deps.closeTable(tableId).catch(() => undefined)
        throw error
      }
      return { round }
    })
  }

  /**
   * A table finished a board (`ClubLink.boardFinished`): the result goes to the event, which keeps
   * it once (`e9-t12`: the scores are worked out from the results whenever the page is read). An
   * event that does not answer throws: the table offers the board again (its outbox, §5.10)
   */
  async boardFinished(report: Extract<EventReport, { kind: 'pairs' }>) {
    if (!report.result || !this.copies.has(report.eventId)) return
    const { result } = report
    try {
      await this.step(report.eventId, {
        kind: 'result',
        result: {
          round: report.round,
          table: report.table,
          boardNo: report.boardNo,
          ns: report.ns,
          ew: report.ew,
          boardId: result.boardId,
          scoreNS: result.scoreNS,
          contract: result.contract,
          declarerTricks: result.declarerTricks,
          ...(result.lead && { lead: result.lead }),
          playedAt: result.playedAt,
        },
      })
    } catch (error) {
      // A result the event refuses (a round that already ended) does not count; anything else is tried again
      if (!(error instanceof ClubError) || error.code === 'serverError') throw error
      return
    }
    await this.progress(report.eventId)
  }

  /** Whatever the event's state calls for, one at a time: the next round's tables, or closing up the end */
  private progress(id: string): Promise<void> {
    return this.lane(id, () => this.advance(id)).catch((error) => this.deps.log(crashEntry('pairsProgress', error)))
  }

  /** Runs `run` after whatever the event is doing already; its error goes to the caller */
  private lane<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve()
    const result = previous.then(run)
    const next = result.then(
      () => undefined,
      () => undefined,
    )
    this.lanes.set(id, next)
    void next.then(() => {
      if (this.lanes.get(id) === next) this.lanes.delete(id)
    })
    return result
  }

  /**
   * Every table of the round finished (`e9-t11`, 每輪結束換桌): the round's tables are told (each
   * closes once its people leave), everyone leaves them, and the next round's open; the players'
   * pages take them there (`PairsBanner`). The last board of the last round finished the event:
   * its tables are told and every record is shown to everyone, once (`settled`)
   */
  private async advance(id: string) {
    const copy = this.copies.get(id)
    if (!copy) return
    const event = copy.event
    if ((event.status === 'finished' || event.status === 'cancelled') && !copy.settled) {
      await this.deps.store.put(KEY + id, { ...copy, settled: true })
      this.copies.set(id, { ...copy, settled: true })
      for (const tableId of event.roundTables.at(-1) ?? []) if (tableId) await this.deps.endTable(tableId)
      if (event.status === 'finished') {
        await this.deps.reveal(id)
        const ranked = pairsRanked(event, pairsScoring(this.directing(id)))
        if (ranked) this.deps.ranked(ranked)
      }
      return
    }
    if (!nextRoundDue(event)) return
    const round = event.round + 1
    for (const tableId of event.roundTables[event.round - 1] ?? []) if (tableId) await this.deps.endTable(tableId)
    for (const player of pairsPlayers(event)) await this.deps.leave(player)
    const tables = await this.openRound(event, round)
    try {
      await this.step(id, { kind: 'round', round, tables })
    } catch (error) {
      for (const tableId of tables) if (tableId) await this.deps.closeTable(tableId).catch(() => undefined)
      throw error
    }
    // Another call opened the round first: these are not the event's
    const kept = this.copies.get(id)!.event.roundTables[round - 1]
    if (kept && kept.join() !== tables.join())
      for (const tableId of tables) if (tableId) await this.deps.closeTable(tableId).catch(() => undefined)
  }
}

/**
 * A finished event as the points ledger takes it (J2, `kind: 'pairs'`): every pair one side, ranked
 * by its matchpoint percentage across both fields (a Mitchell ranks NS and EW apart, but the
 * percentages compare: each is a share of the tops of the boards that pair played), equal
 * percentages sharing a place; null before the end
 */
export function pairsRanked(event: PairsEvent, scoring: PairsScoringOptions = {}): RankedEvent | null {
  if (event.status !== 'finished' || !event.movement) return null
  // With the director's rulings and penalties (`e9-t17`), as the results page shows them
  const { standings } = scorePairs(event.movement, event.results, scoring)
  const same = 1e-9
  const sides = standings.map((s) => ({
    userIds: event.pairs[s.pair].players,
    robots: 0,
    rank: 1 + standings.filter((o) => o.percent > s.percent + same).length,
  }))
  return { id: event.id, kind: 'pairs', at: event.finishedAt ?? event.startedAt ?? event.createdAt, sides }
}
