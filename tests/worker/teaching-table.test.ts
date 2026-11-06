// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import { parseClientMessage } from '../../shared/message-guard.ts'
import { parseDeal } from '../../shared/pbn.ts'
import { parsePracticeSettings } from '../../shared/practice.ts'
import type { BoardRecord, ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { isTableAction } from '../../shared/protocol.ts'
import { parseTeachMark, TEACH_MARKS_MAX, TEACH_TEXT_MAX } from '../../shared/teaching.ts'
import { TEACH_MARK_BURST } from '../../worker/rate-limit.ts'
import { HELD_BACK } from '../../worker/team-mode.ts'
import { teamHarness } from './team-match-harness.ts'

/**
 * The teaching table (`e10-t10`, `e10-t11`, AC-10.7): who may open one, what a teacher may do, that
 * every message a student's browser gets holds only what a player or a watcher may see, and that the
 * marks never tell where a hidden card is. Nothing played there is kept anywhere.
 */

const DEAL = 'N:AKQJ.AKQ.AKQ.AKQ T987.JT9.JT9.JT9 6543.876.876.876 2.5432.5432.5432'
const HANDS = parseDeal(DEAL)!

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

const inbox = (userId: string): ServerMessage[] => t.h.connections.inbox.get(userId) ?? []
const tableMessages = (userId: string) => inbox(userId).flatMap((m) => (m.type === 'table' && m.table ? [m.table] : []))

async function teacher(name = 'tia') {
  const id = await t.member(name)
  await t.club().adminSetPermissions(id, ['teach'])
  return id
}

/**
 * A teaching table with the fixed deal, North dealing, and students in every seat given (the others
 * empty unless `robots`): the teacher watches
 */
async function classroom(students: Partial<Record<Seat, string>> = { N: 'ann', E: 'bob', S: 'sam', W: 'wil' }, robots: Seat[] = []) {
  const tia = await teacher()
  await t.club().importOwnDeals(tia, { deals: [{ boardNo: 1, dealer: 'N', vul: 'None', hands: DEAL, title: 'Lesson' }] })
  const [{ id: deal }] = await t.club().ownDealList(tia)
  await t.send(tia, { type: 'createTeaching', set: { source: 'mine', ids: [deal] }, access: 'public' })
  const tableId = t.club().lobbyView(tia).myTableId!
  const people = {} as Record<Seat, string>
  for (const seat of SEATS) {
    const name = students[seat]
    if (!name) continue
    people[seat] = await t.member(name)
    await t.send(people[seat], { type: 'sit', tableId, seat })
  }
  for (const seat of robots) await t.send(tia, { type: 'addRobot', seat })
  return { tia, tableId, people }
}

/** North opens 1S and the others pass: North declares, South is dummy, East leads */
async function bid(people: Record<Seat, string>) {
  await t.send(people.N, { type: 'call', call: '1S' })
  for (const seat of ['E', 'S', 'W'] as const) await t.send(people[seat], { type: 'call', call: 'P' })
}

/** Plays the board out: whoever may play puts down their first legal card, as seated (declarer plays dummy) */
async function playOut(people: Record<Seat, string>) {
  for (let i = 0; i < 60; i++) {
    const mover = Object.values(people).find((id) => t.view(id)?.board?.legalCards.length)
    if (!mover) return
    await t.send(mover, { type: 'play', card: t.view(mover)!.board!.legalCards[0] })
  }
}

/** The hands a seated student may see at this point of a board with the fixed auction */
function mayShow(view: TableView): Set<Seat> {
  const board = view.board!
  const allowed = new Set<Seat>([view.mySeat!])
  if (board.phase === 'finished') return new Set(SEATS)
  const led = board.tricks.some((trick) => trick.cards.length > 0)
  if (led && board.dummy) allowed.add(board.dummy)
  if (led && view.mySeat === board.dummy && board.contract) allowed.add(board.contract.declarer)
  return allowed
}

describe('who opens a teaching table', () => {
  it('takes the teach permission the admin gives; others are refused and nothing opens', async () => {
    const amy = await t.member('amy')
    expect(await t.refused(amy, { type: 'createTeaching' })).toBe('noPermission')
    expect(t.club().lobbyView(amy).myTableId).toBeNull()
    await t.club().adminSetPermissions(amy, ['teach'])
    expect(await t.refused(amy, { type: 'createTeaching' })).toBeUndefined()
    const table = t.tableState(t.club().lobbyView(amy).myTableId!)!
    expect(table.mode).toBe('teach')
    expect(table.hostId).toBe(amy)
    expect(t.view(amy)!.teach).toEqual({ paused: false, marks: [], openHands: false, canUndo: false })
    await t.club().adminSetPermissions(amy, [])
    await t.send(amy, { type: 'leaveTable' })
    expect(await t.refused(amy, { type: 'createTeaching' })).toBe('noPermission')
  })

  it('is left out of quick seat and has no director; only who may come in can change', async () => {
    const { tia, tableId } = await classroom({ S: 'sam' })
    const other = await t.member('other')
    await t.send(other, { type: 'quickSeat' })
    expect(t.club().lobbyView(other).myTableId).not.toBe(tableId)
    expect(t.club().lobbyView(tia).tables.find((x) => x.id === tableId)?.teaching).toBe(true)
    expect(await t.refused(tia, { type: 'updateTableSettings', settings: { allowKibitz: false } })).toBe('teachTableFixed')
    expect(await t.refused(tia, { type: 'updateTableSettings', settings: { access: 'hidden' } })).toBeUndefined()
    expect(t.tableState(tableId)!.settings!.access).toBe('hidden')
  })

  it('accepts its messages over the table connection, and a mark only as an object', () => {
    for (const type of ['teachUndo', 'teachReplay', 'teachPause', 'teachMark', 'teachUnmark'] as const)
      expect(isTableAction({ type } as ClientMessage)).toBe(true)
    expect(parseClientMessage(JSON.stringify({ type: 'teachMark', mark: 'SA' }))).toEqual({ error: 'badMessage' })
    expect(parseClientMessage(JSON.stringify({ type: 'teachPause', paused: 1 }))).toEqual({ error: 'badMessage' })
    expect(parseClientMessage(JSON.stringify({ type: 'teachUnmark', id: 'x' }))).toEqual({ error: 'badMessage' })
  })
})

describe('the deals', () => {
  it('deals what the teacher imported from PBN, as it is, and says which of them only by its place', async () => {
    const { tia, people } = await classroom()
    expect(t.view(tia)!.board!.hands).toEqual(HANDS)
    expect(t.view(tia)!.teach!.problem).toEqual({ seq: 1, count: 1, title: 'Lesson' })
    expect(t.view(people.S)!.teach!.problem).toEqual({ seq: 1, count: 1, title: 'Lesson' })
  })

  async function recordOf(player: string, tableMode: 'casual') {
    await t.send(player, { type: 'createTable' })
    const tableId = t.club().lobbyView(player).myTableId!
    for (const seat of ['N', 'E', 'W'] as const) await t.send(player, { type: 'addRobot', seat })
    await t.playUntil([player], () => t.played(tableId) >= 1)
    expect(t.tableState(tableId)!.mode).toBe(tableMode)
    const id = t.tableState(tableId)!.recent![0].id
    await t.send(player, { type: 'leaveTable' })
    return id
  }

  it('deals a record the teacher may read, also one they did not play', async () => {
    const amy = await t.member('amy')
    const id = await recordOf(amy, 'casual')
    const tia = await teacher()
    await t.send(tia, { type: 'createTeaching', set: { source: 'records', ids: [id] } })
    const record = await t.h.store.get<BoardRecord>(`board:${id}`)
    const table = t.tableState(t.club().lobbyView(tia).myTableId!)!
    // Dealt once the seats are taken, and kept on the server until then
    const state = table.modeState as { problems: { hands: unknown }[] }
    expect(state.problems[0].hands).toEqual(record!.board.hands)
    expect(JSON.stringify(inbox(tia))).not.toContain(record!.board.hands.N[0] + '","' + record!.board.hands.N[1])
  })

  it('refuses a record kept back, even to the teacher who played it, as if it did not exist', async () => {
    const tia = await teacher()
    const id = await recordOf(tia, 'casual')
    const record = (await t.h.store.get<BoardRecord>(`board:${id}`))!
    await t.h.store.put(`board:${id}`, { ...record, revealAt: HELD_BACK })
    expect(await t.refused(tia, { type: 'createTeaching', set: { source: 'records', ids: [id] } })).toBe('boardGone')
    expect(await t.refused(tia, { type: 'createTeaching', set: { source: 'records', ids: ['nothing'] } })).toBe('boardGone')
    expect(t.club().lobbyView(tia).myTableId).toBeNull()
  })

  it('never lets a practice table name records, and turns down a set that is not one', async () => {
    expect(parsePracticeSettings({ deal: 'set', set: { source: 'records', ids: ['a'] } })).toEqual({ field: 'set' })
    const tia = await teacher()
    expect(await t.refused(tia, { type: 'createTeaching', set: { source: 'nope' } as never })).toBe('badPracticeSettings')
    expect(await t.refused(tia, { type: 'createTeaching', access: 'nope' as never })).toBe('badTableSettings')
  })
})

describe('what each person sees', () => {
  it('shows the teacher all four hands, seated or not, and a student never more than a player sees', async () => {
    const { tia, people } = await classroom()
    expect(Object.keys(t.view(tia)!.board!.hands)).toHaveLength(4)
    expect(t.view(tia)!.board!.legalCalls).toEqual([])
    await bid(people)
    await playOut(people)
    expect(t.view(people.S)!.board!.phase).toBe('finished')
    for (const seat of SEATS) {
      const messages = tableMessages(people[seat])
      expect(messages.length).toBeGreaterThan(20)
      for (const view of messages) {
        if (!view.board) continue
        const allowed = mayShow(view as TableView)
        for (const shown of Object.keys(view.board.hands) as Seat[])
          expect(allowed.has(shown), `${seat} was sent ${shown}'s hand (${view.board.phase}, ${view.mySeat})`).toBe(true)
        expect(view.teach?.canUndo).toBeUndefined()
      }
      // Nothing else in any message holds the deal before the board was over either: the server's state stays home
      expect(JSON.stringify(messages[0])).not.toContain('problems')
      expect(JSON.stringify(messages.at(-1))).not.toContain('modeState')
    }
  })

  it('a teacher in a seat sees all four and bids only for that seat', async () => {
    const { tia, tableId } = await classroom({ S: 'sam', E: 'bob', W: 'wil' })
    await t.send(tia, { type: 'sit', tableId, seat: 'N' })
    const view = t.view(tia)!
    expect(view.mySeat).toBe('N')
    expect(Object.keys(view.board!.hands)).toHaveLength(4)
    expect(view.board!.legalCalls.length).toBeGreaterThan(0)
    expect(view.teach!.canUndo).toBe(false)
  })

  it('keeps hands from students without a seat until the teacher opens them, and hides them again', async () => {
    const { tia, tableId, people } = await classroom()
    const wes = await t.member('wes')
    await t.send(wes, { type: 'joinTable', tableId })
    expect(t.view(wes)!.mySeat).toBeNull()
    expect(t.view(wes)!.board!.hands).toEqual({})
    // A student who stands up is a student without a seat: no peeking
    await t.send(people.S, { type: 'stand' })
    expect(t.view(people.S)!.board!.hands).toEqual({})
    await t.send(people.S, { type: 'sit', tableId, seat: 'S' })
    // Dummy's hand is for everyone once the lead is made
    await bid(people)
    expect(t.view(wes)!.board!.hands).toEqual({})
    await t.send(people.E, { type: 'play', card: t.view(people.E)!.board!.legalCards[0] })
    expect(Object.keys(t.view(wes)!.board!.hands)).toEqual(['S'])
    // Only the teacher chooses
    expect(await t.refused(wes, { type: 'showHands', show: true })).toBe('teachOnly')
    await t.send(tia, { type: 'showHands', show: true })
    expect(Object.keys(t.view(wes)!.board!.hands)).toHaveLength(4)
    expect(t.view(wes)!.teach!.openHands).toBe(true)
    // Those in a seat see no more for it
    expect(Object.keys(t.view(people.W)!.board!.hands).sort()).toEqual(['S', 'W'])
    await t.send(tia, { type: 'showHands', show: false })
    expect(Object.keys(t.view(wes)!.board!.hands)).toEqual(['S'])
  })

  it('never lets someone outside see a hidden table: the access mode rules as everywhere', async () => {
    const tia = await teacher()
    await t.send(tia, { type: 'createTeaching' })
    const tableId = t.club().lobbyView(tia).myTableId!
    const other = await t.member('other')
    expect(t.club().lobbyView(other).tables.map((x) => x.id)).not.toContain(tableId)
    expect(await t.refused(other, { type: 'joinTable', tableId })).toBe('tableGone')
  })
})

describe('what the teacher may do', () => {
  it('takes back any step of anyone, and a student may not', async () => {
    const { tia, people } = await classroom()
    await t.send(people.N, { type: 'call', call: '1S' })
    await t.send(people.E, { type: 'call', call: 'P' })
    expect(t.view(tia)!.teach!.canUndo).toBe(true)
    expect(await t.refused(people.E, { type: 'teachUndo' })).toBe('teachOnly')
    expect(await t.refused(people.E, { type: 'undoRequest' })).toBe('teachOnly')
    expect(t.view(people.E)!.board!.canUndo).toBe(false)
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.auction.map((c) => c.call)).toEqual(['1S'])
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.auction).toEqual([])
    expect(await t.refused(tia, { type: 'teachUndo' })).toBe('nothingToUndo')
    expect(t.view(tia)!.teach!.canUndo).toBe(false)
  })

  it('takes back cards one by one, reopens the auction, and opens a finished board', async () => {
    const { tia, people } = await classroom()
    await bid(people)
    const lead = t.view(people.E)!.board!.legalCards[0]
    await t.send(people.E, { type: 'play', card: lead })
    expect(t.view(people.W)!.board!.hands.S).toBeDefined()
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.tricks).toEqual([])
    // Dummy is hidden again from the student
    expect(t.view(people.W)!.board!.hands.S).toBeUndefined()
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.phase).toBe('auction')
    expect(t.view(tia)!.board!.contract).toBeNull()
    await t.send(people.W, { type: 'call', call: 'P' })
    await playOut(people)
    expect(t.view(tia)!.board!.phase).toBe('finished')
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.phase).toBe('play')
    expect(t.view(tia)!.board!.result).toBeUndefined()
    expect(t.view(tia)!.board!.tricks.flatMap((x) => x.cards)).toHaveLength(51)
  })

  it('takes a claim back, whether waiting or accepted', async () => {
    const { tia, people } = await classroom()
    await bid(people)
    await t.send(people.E, { type: 'play', card: t.view(people.E)!.board!.legalCards[0] })
    await t.send(people.N, { type: 'claim', tricks: 13 })
    expect(t.view(tia)!.board!.claim).toBeDefined()
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.claim).toBeUndefined()
    // The declarer's hand, laid open by the claim, is hidden from the defenders again
    expect(t.view(people.E)!.board!.hands.N).toBeUndefined()
    expect(t.view(people.E)!.board!.hands.S).toBeDefined()
    await t.send(people.N, { type: 'claim', tricks: 13 })
    await t.send(people.E, { type: 'claimRespond', accept: true })
    await t.send(people.W, { type: 'claimRespond', accept: true })
    expect(t.view(tia)!.board!.phase).toBe('finished')
    await t.send(tia, { type: 'teachUndo' })
    expect(t.view(tia)!.board!.phase).toBe('play')
    expect(t.view(people.W)!.board!.hands.E).toBeUndefined()
  })

  it('replays the same board, and goes on to the next only when asked', async () => {
    const { tia, people } = await classroom()
    await bid(people)
    await playOut(people)
    // The next board does not come by itself
    expect(t.view(tia)!.dealAt).toBeNull()
    expect(t.h.queue.some((job) => job.kind === 'deal')).toBe(false)
    expect(await t.refused(people.S, { type: 'teachReplay' })).toBe('teachOnly')
    expect(await t.refused(people.S, { type: 'redeal' })).toBe('teachOnly')
    await t.send(tia, { type: 'teachReplay' })
    const again = t.view(tia)!.board!
    expect(again.phase).toBe('auction')
    expect(again.auction).toEqual([])
    expect(again.hands).toEqual(HANDS)
    expect(again.boardNo).toBe(1)
    // A student is back to their own hand
    expect(Object.keys(t.view(people.S)!.board!.hands)).toEqual(['S'])
    await t.send(tia, { type: 'redeal' })
    expect(t.view(tia)!.board!.hands).toEqual(HANDS)
    expect(t.view(tia)!.board!.auction).toEqual([])
  })

  it('other tables refuse the teacher’s actions', async () => {
    const amy = await t.member('amy')
    await t.send(amy, { type: 'createTable' })
    expect(await t.refused(amy, { type: 'teachUndo' })).toBe('teachOnly')
    expect(await t.refused(amy, { type: 'teachPause', paused: true })).toBe('teachOnly')
    expect(await t.refused(amy, { type: 'teachMark', mark: { kind: 'circle', card: 'SA' } })).toBe('teachOnly')
    expect(await t.refused(amy, { type: 'redeal' })).toBe('practiceOnly')
  })
})

describe('nothing is kept', () => {
  it('a finished board leaves no record, no count and nothing to send on', async () => {
    const { tia, tableId, people } = await classroom()
    await bid(people)
    await playOut(people)
    const table = t.tableState(tableId)!
    expect(table.board!.phase).toBe('finished')
    expect(table.outbox).toBeUndefined()
    expect(table.recordId).toBeUndefined()
    expect(table.boardsPlayed).toBe(0)
    expect(t.view(people.S)!.recent).toEqual([])
    expect(t.view(tia)!.board!.recordId).toBeUndefined()
    for (const id of [tia, people.S]) {
      expect((await t.club().search(id, DEFAULT_HISTORY_QUERY)).total).toBe(0)
      expect((await t.club().search(id, { ...DEFAULT_HISTORY_QUERY, scope: 'all' })).total).toBe(0)
    }
    expect((await t.h.store.list('board:')).size).toBe(0)
    expect((await t.h.store.list('hist:')).size).toBe(0)
  })
})

describe('leaving', () => {
  it('closes with its teacher, and the students go too; a student leaving changes nothing', async () => {
    const { tia, tableId, people } = await classroom()
    await t.send(people.S, { type: 'leaveTable' })
    expect(t.tableState(tableId)).not.toBeNull()
    await t.send(tia, { type: 'leaveTable' })
    expect(t.tableState(tableId)).toBeNull()
    expect(t.club().lobbyView(people.N).myTableId).toBeNull()
  })

  it('waits for a teacher who dropped offline, not for ever; coming back keeps it', async () => {
    const { tia, tableId } = await classroom()
    const drop = async () => {
      t.h.connections.online.delete(tia)
      await t.club().disconnected(tia)
    }
    await drop()
    expect(t.tableState(tableId)).not.toBeNull()
    expect(t.tableState(tableId)!.spectators).toContain(tia)
    expect(t.tableState(tableId)!.hostId).toBe(tia)
    t.h.connections.online.add(tia)
    t.club().connected(tia)
    t.h.time += 60 * 60_000
    await t.run('substitute')
    expect(t.tableState(tableId)).not.toBeNull()
    await drop()
    await t.run('substitute')
    expect(t.tableState(tableId)).not.toBeNull()
    t.h.time += 11 * 60_000
    await t.run('substitute')
    await t.run('substitute')
    expect(t.tableState(tableId)).toBeNull()
  })

  it('closes when the teacher’s account goes', async () => {
    const { tia, tableId } = await classroom()
    await t.club().adminDeleteUser(t.h.boss, tia)
    expect(t.tableState(tableId)).toBeNull()
  })
})

describe('pausing and marks (e10-t11)', () => {
  /** After North's 1S and the passes: East is to lead */
  async function paused() {
    const room = await classroom()
    await bid(room.people)
    await t.send(room.tia, { type: 'teachPause', paused: true })
    return room
  }
  const marksOf = (id: string) => t.view(id)!.teach!.marks

  it('stops everyone while paused, and goes on when the teacher says so', async () => {
    const { tia, people } = await paused()
    expect(t.view(people.E)!.teach!.paused).toBe(true)
    expect(t.view(people.E)!.board!.legalCards).toEqual([])
    expect(t.view(people.N)!.board!.canClaim).toBe(false)
    const card = HANDS.E[0]
    expect(await t.refused(people.E, { type: 'play', card })).toBe('teachPaused')
    expect(await t.refused(people.N, { type: 'claim', tricks: 3 })).toBe('teachPaused')
    expect(await t.refused(people.S, { type: 'teachPause', paused: false })).toBe('teachOnly')
    // Chat goes on: it is a lesson
    expect(await t.refused(people.S, { type: 'chat', text: 'why?' })).toBeUndefined()
    await t.send(tia, { type: 'teachPause', paused: false })
    expect(t.view(people.E)!.teach!.paused).toBe(false)
    expect(t.view(people.E)!.board!.legalCards.length).toBeGreaterThan(0)
  })

  it('stops the robots too, and they go on after', async () => {
    const tia = await teacher()
    await t.send(tia, { type: 'createTeaching' })
    const tableId = t.club().lobbyView(tia).myTableId!
    for (const seat of SEATS) await t.send(tia, { type: 'addRobot', seat })
    expect(t.view(tia)!.board).not.toBeNull()
    await t.send(tia, { type: 'teachPause', paused: true })
    const before = t.tableState(tableId)!.board!.auction.length
    await t.run('robot')
    await t.run('robot')
    expect(t.tableState(tableId)!.board!.auction).toHaveLength(before)
    await t.send(tia, { type: 'teachPause', paused: false })
    await t.playUntil([], () => t.tableState(tableId)!.board!.phase === 'finished')
    expect(t.tableState(tableId)!.outbox).toBeUndefined()
  })

  it('is the teacher’s alone: a student’s mark goes nowhere, whatever it says', async () => {
    const { people, tia } = await paused()
    for (const message of [
      { type: 'teachMark', mark: { kind: 'text', text: 'hi' } },
      { type: 'teachUnmark' },
    ] as ClientMessage[])
      expect(await t.refused(people.S, message)).toBe('teachOnly')
    expect(marksOf(tia)).toEqual([])
  })

  it('sends a circle only to those who can see the card', async () => {
    const { tia, people } = await paused()
    // West's card: during the wait for the lead only West holds it in view
    const west = HANDS.W[0]
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: west } })
    expect(marksOf(tia)).toMatchObject([{ kind: 'circle', card: west }])
    expect(marksOf(people.W)).toMatchObject([{ kind: 'circle', card: west }])
    for (const seat of ['N', 'E', 'S'] as const) {
      expect(marksOf(people[seat])).toEqual([])
      // Not in anything they were ever sent
      expect(JSON.stringify(tableMessages(people[seat]).map((m) => m.teach))).not.toContain(west)
    }
    // A watcher with the hands hidden does not get it, with them open does
    const wes = await t.member('wes')
    await t.send(wes, { type: 'joinTable', tableId: t.club().lobbyView(tia).myTableId! })
    expect(marksOf(wes)).toEqual([])
    await t.send(tia, { type: 'showHands', show: true })
    expect(marksOf(wes)).toMatchObject([{ kind: 'circle', card: west }])
  })

  it('does not even push anything to a student for a mark they cannot see, and leaves no gap in the ids', async () => {
    const { tia, people } = await paused()
    const before = inbox(people.S).length
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: HANDS.W[0] } })
    expect(inbox(people.S).slice(before).filter((m) => m.type === 'table')).toEqual([])
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: HANDS.S[0] } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: HANDS.S[1] } })
    expect(marksOf(people.S).map((m) => m.id)).toEqual([0, 1])
    expect(marksOf(tia).map((m) => m.id)).toEqual([1, 2, 3])
  })

  it('drops an arrow with an end on a hidden card, and keeps one on seats or cards in view', async () => {
    const { tia, people } = await paused()
    const south = HANDS.S[0]
    const west = HANDS.W[0]
    await t.send(tia, { type: 'teachMark', mark: { kind: 'arrow', from: { card: south }, to: { card: west } } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'arrow', from: { seat: 'N' }, to: { card: west } } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'arrow', from: { seat: 'N' }, to: { card: south } } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'arrow', from: { seat: 'N' }, to: { seat: 'E' } } })
    expect(marksOf(tia)).toHaveLength(4)
    expect(marksOf(people.S)).toMatchObject([
      { kind: 'arrow', from: { seat: 'N' }, to: { card: south } },
      { kind: 'arrow', from: { seat: 'N' }, to: { seat: 'E' } },
    ])
    expect(JSON.stringify(marksOf(people.S))).not.toContain(west)
    expect(JSON.stringify(marksOf(people.E))).not.toContain(south)
  })

  it('follows what is in view: dummy once it is down, a played card, and back when it is taken back', async () => {
    const { tia, people } = await classroom()
    await bid(people)
    const lead = t.view(people.E)!.board!.legalCards[0]
    await t.send(people.E, { type: 'play', card: lead })
    await t.send(tia, { type: 'teachPause', paused: true })
    const dummy = HANDS.S[0]
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: dummy } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'circle', card: lead } })
    expect(marksOf(people.W)).toMatchObject([{ card: dummy }, { card: lead }])
    await t.send(tia, { type: 'teachUndo' })
    // The lead is back in East's hand and dummy is not down: neither goes out any more
    expect(marksOf(people.W)).toEqual([])
    expect(marksOf(people.E)).toMatchObject([{ card: lead }])
    expect(marksOf(tia)).toHaveLength(2)
  })

  it('sends text to everyone, one line and bounded', async () => {
    const { tia, people } = await paused()
    await t.send(tia, { type: 'teachMark', mark: { kind: 'text', text: '  look\n\tat‮ this ', seat: 'E' } })
    expect(marksOf(people.S)).toMatchObject([{ kind: 'text', text: 'look at this', seat: 'E' }])
    const long = 'x'.repeat(TEACH_TEXT_MAX)
    await t.send(tia, { type: 'teachMark', mark: { kind: 'text', text: long } })
    expect(marksOf(people.S)).toHaveLength(2)
    expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'text', text: long + 'x' } })).toBe('teachBadMark')
    expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'text', text: ' \n ' } })).toBe('teachBadMark')
  })

  it('checks each mark: its shape, while paused only, and how many', async () => {
    const { tia } = await classroom()
    expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'circle', card: 'SA' } })).toBe('teachNotPaused')
    await t.send(tia, { type: 'teachPause', paused: true })
    for (const mark of [
      { kind: 'circle', card: 'ZZ' },
      { kind: 'circle', card: 'SA', extra: 1 },
      { kind: 'arrow', from: { seat: 'N' }, to: { seat: 'N' } },
      { kind: 'arrow', from: { seat: 'N', card: 'SA' }, to: { seat: 'E' } },
      { kind: 'arrow', from: 'N', to: 'E' },
      { kind: 'text', text: 'x', seat: 'Q' },
      { kind: 'text', text: 3 },
      { kind: 'scribble' },
    ])
      expect(parseTeachMark(mark), JSON.stringify(mark)).toBeNull()
    expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'scribble' } as never })).toBe('teachBadMark')
    // One at a time, under the rate limit
    for (let i = 0; i < TEACH_MARKS_MAX; i++) {
      t.h.time += 1000
      expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'circle', card: HANDS.N[i % 13] } })).toBeUndefined()
    }
    t.h.time += 1000
    expect(await t.refused(tia, { type: 'teachMark', mark: { kind: 'circle', card: 'SA' } })).toBe('teachTooManyMarks')
  })

  it('limits how fast they come', async () => {
    const { tia } = await paused()
    let refused: string | undefined
    for (let i = 0; i <= TEACH_MARK_BURST && !refused; i++) refused = await t.refused(tia, { type: 'teachUnmark' })
    expect(refused).toBe('teachMarkTooFast')
    t.h.time += 10_000
    expect(await t.refused(tia, { type: 'teachUnmark' })).toBeUndefined()
  })

  it('clears the marks on going on, on replay and on the next board; one comes off by id', async () => {
    const { tia, people } = await paused()
    await t.send(tia, { type: 'teachMark', mark: { kind: 'text', text: 'a' } })
    await t.send(tia, { type: 'teachMark', mark: { kind: 'text', text: 'b' } })
    const [first] = marksOf(tia)
    await t.send(tia, { type: 'teachUnmark', id: first.id })
    expect(marksOf(people.S)).toMatchObject([{ text: 'b' }])
    await t.send(tia, { type: 'teachPause', paused: false })
    expect(marksOf(tia)).toEqual([])
    expect(marksOf(people.S)).toEqual([])
    for (const message of [{ type: 'teachReplay' }, { type: 'redeal' }] as ClientMessage[]) {
      t.h.time += 10_000
      await t.send(tia, { type: 'teachPause', paused: true })
      await t.send(tia, { type: 'teachMark', mark: { kind: 'text', text: 'c' } })
      await t.send(tia, message)
      expect(t.view(people.S)!.teach).toMatchObject({ paused: false, marks: [] })
    }
  })
})
