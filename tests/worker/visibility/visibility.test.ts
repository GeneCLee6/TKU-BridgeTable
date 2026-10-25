// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Seat } from '../../../shared/cards.ts'
import { DEFAULT_HISTORY_QUERY } from '../../../shared/history-query.ts'
import type { ServerMessage } from '../../../shared/protocol.ts'
import { listQuery } from '../../../worker/history-index.ts'
import { searchReplica } from '../../../worker/history-replica.ts'
import { at, teamHarness } from '../team-match-harness.ts'

/**
 * The information-isolation regression suite (`e11-t13`, AC-11.8; ARCHITECTURE.md §4): in one place,
 * for every kind of table — casual, practice, challenge and team match — and every role at it,
 * nothing reaches a browser that its member may not see. Two kinds of checks:
 *
 * - **Every message, after the fact**: each test plays real boards with robots while every message
 *   each member's browser was sent is kept; `noHiddenCards` then goes through all of them and fails
 *   on any card a seated player could not have seen at that point (only their own hand during the
 *   auction; their own and dummy's after the opening lead, dummy also declarer's), and on any
 *   hidden hand sent to someone without a seat at a table that allows no kibitzers. Robots never
 *   claim and the members here never do, so no claim opens a hand.
 * - **Every way to a finished board**: `exposure` asks each surface the club has — the record, the
 *   history list, search (mine and everyone's), a member's profile, favourites, the traveller and
 *   featuring it — whether a member may get the board, so a board still kept back is checked
 *   everywhere at once, and so is the same board once it is shown.
 *
 * It runs with the rest of `tests/worker` in CI (`npm test`). A new surface or table mode belongs here.
 */

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

const inbox = (userId: string): ServerMessage[] => t.h.connections.inbox.get(userId) ?? []

/** Fails on any card a member's browser was sent that they could not see then (see above) */
function noHiddenCards(userId: string) {
  let checked = 0
  for (const message of inbox(userId)) {
    if (message.type !== 'table' || !message.table?.board) continue
    const view = message.table
    const board = view.board!
    if (board.phase === 'finished') continue
    const led = board.tricks.some((trick) => trick.cards.length > 0)
    const allowed = new Set<Seat>()
    if (view.mySeat) {
      allowed.add(view.mySeat)
      if (led && board.dummy) allowed.add(board.dummy)
      if (led && view.mySeat === board.dummy && board.contract) allowed.add(board.contract.declarer)
    } else if (view.settings.allowKibitz) for (const seat of SEATS) allowed.add(seat)
    else if (led && board.dummy) allowed.add(board.dummy)
    for (const seat of Object.keys(board.hands) as Seat[])
      expect(allowed.has(seat), `${userId} saw ${seat} on board ${board.boardNo} (${board.phase}, seat ${view.mySeat})`).toBe(true)
    checked++
  }
  return checked
}

/** Every way the club gives a finished board, and whether this member gets it there */
async function exposure(viewer: string, boardId: string, player: string) {
  const club = t.club()
  const has = (page: { boards: { id: string }[] }) => page.boards.some((b) => b.id === boardId)
  const all = { ...DEFAULT_HISTORY_QUERY, scope: 'all' as const }
  // The history pages the Worker answers from D1 at the edge (§5.12) answer exactly as the club does
  await t.copyToD1()
  for (const query of [listQuery(true, 1, 20), DEFAULT_HISTORY_QUERY, all, { ...all, mode: 'team' as const }, { ...all, player }])
    expect(await searchReplica(t.d1, query, viewer, t.h.time), `the edge, ${JSON.stringify(query)}`).toEqual(await club.search(viewer, query))
  return {
    record: (await club.record(boardId, viewer)) !== null,
    history: has(await club.history(viewer, true)),
    mine: has(await club.search(viewer, DEFAULT_HISTORY_QUERY)),
    search: has(await club.search(viewer, all)) || has(await club.search(viewer, { ...all, mode: 'team' })),
    profile: (await club.memberProfile(viewer, player)).recent.some((b) => b.id === boardId),
    favorite: await club.favorite(viewer, boardId).then(
      () => true,
      () => false,
    ),
    traveller: (await club.traveller(boardId, viewer)) !== null,
  }
}

const hidden = { record: false, history: false, mine: false, search: false, profile: false, favorite: false, traveller: false }

/** What a curator gets trying to feature the board: the board must be public first, and an outsider is not told it exists */
const featureCode = (curator: string, boardId: string) =>
  t
    .club()
    .featured.set(curator, boardId, { title: 'x', category: 'other' })
    .then(
      () => 'featured',
      (error: { code: string }) => error.code,
    )

describe('casual tables', () => {
  it('shows a seated player their own hand (and dummy after the lead), a kibitzer all four, and someone without a seat at a no-kibitzing table only dummy', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    await t.send(amy, { type: 'createTable' })
    const open = t.club().lobbyView(amy).myTableId!
    for (const seat of ['N', 'E', 'W'] as const) await t.send(amy, { type: 'addRobot', seat })
    await t.send(ben, { type: 'joinTable', tableId: open })

    const cat = await t.member('cat')
    const dan = await t.member('dan')
    const eve = await t.member('eve')
    await t.send(cat, { type: 'createTable', settings: { allowKibitz: false } })
    const closed = t.club().lobbyView(cat).myTableId!
    await t.send(dan, { type: 'sit', tableId: closed, seat: 'N' })
    for (const seat of ['E', 'W'] as const) await t.send(cat, { type: 'addRobot', seat })
    expect(await t.refused(eve, { type: 'joinTable', tableId: closed })).toBe('noKibitzing')

    await t.playUntil([amy, cat, dan], () => t.played(open) >= 2 && t.played(closed) >= 2)
    expect(noHiddenCards(amy)).toBeGreaterThan(10)
    expect(noHiddenCards(cat)).toBeGreaterThan(10)
    expect(noHiddenCards(dan)).toBeGreaterThan(10)
    // The kibitzer saw all four, which is allowed
    expect(noHiddenCards(ben)).toBeGreaterThan(10)
    expect(inbox(eve).some((m) => m.type === 'table' && m.table?.id === closed)).toBe(false)
  })
})

describe('practice tables', () => {
  it('are their member’s alone: nobody else joins, sits or is sent anything of them', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    await t.send(amy, { type: 'createPractice', settings: { deal: 'random', robotKind: 'tku', justDeclare: false } })
    const practice = t.club().lobbyView(amy).myTableId!
    expect(await t.refused(ben, { type: 'joinTable', tableId: practice })).toBe('tableGone')
    expect(await t.refused(ben, { type: 'sit', tableId: practice, seat: 'N' })).toBe('tableGone')
    expect(t.club().lobbyView(ben).tables.map((x) => x.id)).not.toContain(practice)
    await t.playUntil([amy], () => t.played(practice) >= 1)
    // A passed-out board sends only a few table messages; every one of them is still checked
    expect(noHiddenCards(amy)).toBeGreaterThan(2)
    expect(JSON.stringify(inbox(ben))).not.toContain(practice)
    // Practice boards are never featured (they may have been dealt again)
    const board = t.tableState(practice)!.recent![0].id
    expect(await featureCode(t.h.boss, board)).toBe('practiceNotFeatured')
  })
})

describe('challenge tables', () => {
  it('keeps a challenge board from everyone but its player until the challenge ends, on every surface', async () => {
    const gus = await t.member('gus')
    const hal = await t.member('hal')
    const ivy = await t.member('ivy')
    await t.send(gus, { type: 'setFriend', userId: hal, friend: true })
    expect(await t.refused(gus, { type: 'createChallenge', invitees: [hal], boards: 4 })).toBeUndefined()
    const id = t.club().challengeList(gus)[0].id
    await t.send(hal, { type: 'answerChallenge', challengeId: id, accept: true })
    await t.send(gus, { type: 'playChallenge', challengeId: id })
    const table = t.club().lobbyView(gus).myTableId!
    // Nobody else comes near the table
    expect(await t.refused(ivy, { type: 'joinTable', tableId: table })).toBe('tableGone')
    await t.playUntil([gus], () => t.played(table) >= 1)
    // A passed-out board sends only a few table messages; every one of them is still checked
    expect(noHiddenCards(gus)).toBeGreaterThan(2)
    const board = t.tableState(table)!.recent![0].id

    expect(await exposure(gus, board, gus)).toMatchObject({ record: true, mine: true, favorite: true })
    // Hal is in the challenge and has not finished: not even the traveller. Ivy is not in it
    for (const viewer of [hal, ivy]) expect(await exposure(viewer, board, gus)).toEqual(hidden)
    expect(t.club().challengeFor(id, hal)?.travellers).toBeUndefined()
    expect(t.club().challengeFor(id, ivy)).toBeNull()
    expect(await featureCode(t.h.boss, board)).toBe('boardGone')
    for (const viewer of [hal, ivy]) expect(JSON.stringify(inbox(viewer))).not.toContain(board)
  })
})

describe('team match tables', () => {
  it('keeps the other room’s cards, boards and score from the players, and a board from everyone until both rooms played it', async () => {
    const { id, amy, people } = await t.match({ boards: 4, seats: { ben: at('closed', 'S'), bea: at('closed', 'E') } })
    const { ben, bea } = people
    const cat = await t.member('cat')
    await t.send(amy, { type: 'startMatch', matchId: id })
    const open = t.tableIdOf(id, 'open')
    const closed = t.tableIdOf(id, 'closed')
    await t.send(cat, { type: 'joinTable', tableId: open })
    // Players never watch a table of their match: not the other room, not their own
    for (const player of [ben, bea]) expect(await t.refused(player, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    await t.send(amy, { type: 'matchSitIn', matchId: id, room: 'closed', seat: 'S' })
    expect(await t.refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    await t.send(ben, { type: 'joinTable', tableId: closed })
    expect(t.tableState(closed)!.seats.S).toBe(ben)
    expect(t.tableState(closed)!.spectators).toEqual([])

    // The open room finishes board 1 while the closed room still plays it
    await t.playUntil([amy], () => t.played(open) === 1)
    const first = t.tableState(open)!.recent![0].id
    expect(await exposure(amy, first, amy)).toMatchObject({ record: true, mine: true, favorite: true, traveller: false })
    for (const viewer of [ben, bea, cat]) expect(await exposure(viewer, first, amy)).toEqual(hidden)
    expect(await featureCode(t.h.boss, first)).toBe('boardGone')
    for (const player of [ben, bea]) {
      const sent = inbox(player)
      // Not a message about the other room's table, not its record, not its score
      expect(sent.some((m) => m.type === 'table' && m.table?.id === open)).toBe(false)
      expect(JSON.stringify(sent)).not.toContain(first)
      for (const m of sent)
        if (m.type === 'match' && m.match) for (const board of m.match.boards) expect(!!(board.open && board.closed) || !!board.ruling).toBe(true)
    }
    // A kibitzer's chat never reaches the players
    await t.send(cat, { type: 'chat', text: 'open room made 4S' })
    expect(JSON.stringify(inbox(amy))).not.toContain('open room made 4S')

    // Once both rooms played board 1 it is everyone's: record, search, profile, favourites
    await t.playUntil([ben, bea], () => t.played(closed) === 1)
    expect(await exposure(cat, first, amy)).toMatchObject({ record: true, history: true, search: true, profile: true, favorite: true })
    expect(await featureCode(t.h.boss, first)).toBe('featured')

    await t.playUntil([amy, ben, bea], () => t.club().matches.get(id, amy)!.status === 'finished')
    for (const userId of [amy, ben, bea]) expect(noHiddenCards(userId)).toBeGreaterThan(10)
    expect(noHiddenCards(cat)).toBeGreaterThan(10)
  })
})
