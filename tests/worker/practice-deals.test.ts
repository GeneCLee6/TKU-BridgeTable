// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { dealerOf, secureRandomInt, vulnerabilityOf } from '../../shared/board.ts'
import { hcp, SEATS, suitOf, type Seat } from '../../shared/cards.ts'
import { conditionsProblem, dealWith, meetsConditions, type DealConditions } from '../../shared/dealer.ts'
import { parseClientMessage } from '../../shared/message-guard.ts'
import { formatHand, parseDeal, parseHand } from '../../shared/pbn.ts'
import { parsePracticeSettings, PRACTICE_PRESETS_MAX, quickRandom } from '../../shared/practice.ts'
import {
  boardNoFor,
  loadPracticeSets,
  PRACTICE_SET_ERRORS,
  PRACTICE_SETS,
  practiceSetInfos,
} from '../../shared/practice-sets/index.ts'
import type { ClientMessage, ServerMessage, TableView } from '../../shared/protocol.ts'
import { ClubService, type Connections, type ScheduleKind } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The bidding practice room, part two (`e10-t16`): each seat's points and shape or its whole hand,
 * contradictions told apart from deals too hard to find, all four hands shown to the member alone,
 * saved settings, and deal sets (the club's practice sets, favourites, featured boards)
 */

class FakeConnections implements Connections {
  online = new Set<string>()
  inbox = new Map<string, ServerMessage[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), message])
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
  last<T extends ServerMessage['type']>(userId: string, type: T) {
    return (this.inbox.get(userId) ?? []).findLast((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined
  }
  table(userId: string): TableView | null {
    let view = null as TableView | null
    for (const m of this.inbox.get(userId) ?? []) {
      if (m.type !== 'table') continue
      const wire = m.table
      if (!wire) {
        view = null
        continue
      }
      const keep = view?.id === wire.id ? view : null
      view = { ...wire, chat: wire.chat ?? keep?.chat ?? [], recent: wire.recent ?? keep?.recent ?? [] }
    }
    return view
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let queue: { run: () => void; ms: number; kind: ScheduleKind }[]
let time: number
let boss: string

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  queue = []
  time = 1_000_000
  club = new ClubService(store, connections, {
    maxUsers: 40,
    now: () => time,
    schedule: (run, ms, kind) => queue.push({ run, ms, kind }),
  })
  await club.load()
  const founder = await club.register('boss', 'secret1', '')
  boss = 'user' in founder ? founder.user.id : ''
  connections.online.add(boss)
  club.connected(boss)
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function runRobots(limit = 400) {
  for (let i = 0; i < limit; i++) {
    const index = queue.findIndex((job) => job.kind === 'robot')
    if (index < 0) return
    queue.splice(index, 1)[0].run()
    await tick()
  }
}

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  connections.online.add(user.id)
  club.connected(user.id)
  await tick()
  return user.id
}

const send = (userId: string, message: ClientMessage) => club.handle(userId, message)
const view = (userId: string) => connections.table(userId)

async function refused(userId: string, message: ClientMessage) {
  connections.inbox.set(userId, [])
  await send(userId, message)
  return connections.last(userId, 'error')
}

const practice = (userId: string, settings: Record<string, unknown> = {}) =>
  send(userId, { type: 'createPractice', settings } as unknown as ClientMessage)

/** Passes in the auction and plays the first legal card until the board is over */
async function playBoard(userId: string) {
  for (let i = 0; i < 400; i++) {
    await runRobots()
    const board = view(userId)?.board
    if (!board) throw new Error('no board')
    if (board.phase === 'finished') return
    if (board.legalCalls.length) await send(userId, { type: 'call', call: 'P' })
    else if (board.legalCards.length) await send(userId, { type: 'play', card: board.legalCards[0] })
    else throw new Error(`stuck: ${board.phase}, turn ${board.turn}`)
  }
}

/** Passes for every seat the member bids for until the auction is over */
async function passOut(userId: string) {
  for (let n = 0; n < 60; n++) {
    await runRobots()
    const board = view(userId)!.board!
    if (board.phase !== 'auction') return
    await send(userId, { type: 'call', call: 'P', seat: board.turn! })
  }
}

const SOUTH = parseHand('AKQ2.K73.9.AJ852')!

describe('each seat’s conditions (e10-t16)', () => {
  it('reads hands written as PBN, and nothing else', () => {
    expect(SOUTH).toHaveLength(13)
    expect(formatHand(SOUTH)).toBe('AKQ2.K73.9.AJ852')
    expect(parseHand('akq2.k73.9.aj852')).toEqual(SOUTH)
    expect(parseHand('AKQ2.K73..AJ8652')).toHaveLength(13)
    expect(parseHand('A10.K73.9.AJ852', null)).toContain('ST')
    expect(parseHand('AKQ2.K73.9.AJ85')).toBeNull()
    expect(parseHand('AKQ2.K73.9.AJ8522')).toBeNull()
    expect(parseHand('AKQX.K73.9.AJ852')).toBeNull()
    expect(parseHand('AKQ2.K73.9')).toBeNull()
    const deal = parseDeal('N:KQ84.J75.Q3.J863 T96.KT98.A976.K5 AJ5.AQ3.KJ84.Q92 732.642.T52.AT74')!
    expect(formatHand(deal.S)).toBe('AJ5.AQ3.KJ84.Q92')
    // From another seat, the hands go round the table from it
    expect(parseDeal('S:AJ5.AQ3.KJ84.Q92 732.642.T52.AT74 KQ84.J75.Q3.J863 T96.KT98.A976.K5')).toEqual(deal)
    expect(parseDeal('N:KQ84.J75.Q3.J863 KQ84.J75.Q3.J863 AJ5.AQ3.KJ84.Q92 732.642.T52.AT74')).toBeNull()
  })

  it('takes points and shape for all four seats, shapes, the longest and shortest suit, and a whole hand', () => {
    const conditions: DealConditions = {
      seats: {
        N: { hcp: [6, 9], shapes: ['5332', '4432'] },
        E: { longest: [6, 13] },
        S: { hand: SOUTH },
        W: { shortest: [0, 1], hcp: [0, 10] },
      },
    }
    expect(parsePracticeSettings({ deal: 'custom', conditions })).toEqual({
      settings: { deal: 'custom', conditions, robotKind: 'gib', justDeclare: false },
    })
    const random = quickRandom(secureRandomInt)
    for (let i = 0; i < 20; i++) {
      const dealt = dealWith(conditions, random, 50_000)
      expect(dealt.ok).toBe(true)
      if (!dealt.ok) return
      expect(dealt.hands.S).toEqual(SOUTH)
      expect(meetsConditions(conditions, dealt.hands)).toBe(true)
      expect(new Set(SEATS.flatMap((seat) => dealt.hands[seat])).size).toBe(52)
      const lengths = (seat: Seat) => ['S', 'H', 'D', 'C'].map((suit) => dealt.hands[seat].filter((c) => suitOf(c) === suit).length)
      expect(Math.max(...lengths('E'))).toBeGreaterThanOrEqual(6)
      expect(Math.min(...lengths('W'))).toBeLessThanOrEqual(1)
      expect(hcp(dealt.hands.N)).toBeLessThanOrEqual(9)
    }
    // Not well formed: no such shape, a hand of twelve cards, a range that is no range
    for (const S of [{ shapes: ['5431', '9999'] }, { hand: SOUTH.slice(1) }, { longest: 5 }, { hand: [...SOUTH.slice(1), SOUTH[1]] }])
      expect(parsePracticeSettings({ deal: 'custom', conditions: { seats: { S } } })).toEqual({ field: 'conditions' })
  })

  it('says where conditions contradict each other', () => {
    const problem = (seats: DealConditions['seats'], sides?: DealConditions['sides']) => conditionsProblem({ seats, sides })
    // Balanced with a void; a 5-3-3-2 with a six-card suit; a void and no suit under three
    expect(problem({ S: { balanced: true, shortest: [0, 0] } })).toBe('S.shape')
    expect(problem({ S: { shapes: ['5332'], longest: [6, 13] } })).toBe('S.shape')
    expect(problem({ E: { shapes: ['4333'], lengths: { S: [5, 13] } } })).toBe('E.shape')
    expect(problem({ W: { shortest: [4, 13] } })).toBe('W.shape')
    // The pack has 40 points: four seats or two sides cannot hold more, or fewer
    expect(problem({ N: { hcp: [15, 37] }, S: { hcp: [15, 37] }, E: { hcp: [11, 37] } })).toBe('hcp')
    expect(problem({ N: { hcp: [0, 5] }, E: { hcp: [0, 5] }, S: { hcp: [0, 5] }, W: { hcp: [0, 5] } })).toBe('hcp')
    expect(problem({ N: { hcp: [0, 5] }, S: { hcp: [0, 5] } }, { NS: { hcp: [20, 40] } })).toBe('NS.hcp')
    expect(problem({}, { NS: { hcp: [25, 40] }, EW: { hcp: [20, 40] } })).toBe('hcp')
    // A hand given that does not meet its own seat's conditions, or a card in two hands
    expect(problem({ S: { hand: SOUTH, hcp: [0, 10] } })).toBe('S.hand')
    expect(problem({ S: { hand: SOUTH, balanced: true } })).toBe('S.hand')
    expect(problem({ S: { hand: SOUTH }, N: { hand: SOUTH } })).toBe('hands')
    expect(problem({ S: { hand: SOUTH }, N: { lengths: { C: [9, 13] } } })).toBe('lengths.C')
    expect(problem({ S: { hand: SOUTH, hcp: [17, 17] } })).toBeNull()
    expect(parsePracticeSettings({ deal: 'custom', conditions: { seats: { S: { balanced: true, shortest: [0, 0] } } } })).toEqual({
      field: 'conditions',
      problem: 'S.shape',
    })
  })

  it('turns down contradicting conditions with their own error, and conditions too hard to deal with another', async () => {
    const amy = await member('amy')
    const contradicting = { deal: 'custom', conditions: { seats: { N: { hcp: [21, 37] }, S: { hcp: [20, 37] } } } }
    const error = await refused(amy, { type: 'createPractice', settings: contradicting } as unknown as ClientMessage)
    expect(error).toMatchObject({ code: 'dealConflict', params: { where: 'hcp' } })
    // Possible, but not found in the practice table's tries
    const hard = { deal: 'custom', conditions: { seats: { S: { hcp: [30, 37], shortest: [0, 0] } } } }
    expect((await refused(amy, { type: 'createPractice', settings: hard } as unknown as ClientMessage))?.code).toBe('dealTooStrict')
    expect(club.lobbyView(amy).myTableId).toBeNull()
  })

  it('deals the hand the member gave every board, the other seats to their conditions', async () => {
    const amy = await member('amy')
    await practice(amy, { deal: 'custom', conditions: { seats: { S: { hand: SOUTH }, N: { hcp: [10, 12], balanced: true } } }, biddingOnly: true })
    for (let i = 0; i < 3; i++) {
      const board = view(amy)!.board!
      expect(board.hands.S).toEqual(SOUTH)
      await passOut(amy)
      const open = view(amy)!.board!
      expect(hcp(open.hands.N!)).toBeGreaterThanOrEqual(10)
      expect(hcp(open.hands.N!)).toBeLessThanOrEqual(12)
      await send(amy, { type: 'redeal' })
    }
  })
})

describe('顯示四家: all four hands for the member alone (e10-t16)', () => {
  it('shows the member every hand while bidding once they turn it on, and hides them again', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    await practice(amy, { biddingOnly: true })
    expect(Object.keys(view(amy)!.board!.hands)).toEqual(['S'])
    await send(amy, { type: 'showHands', show: true })
    let table = view(amy)!
    expect(table.practice?.showHands).toBe(true)
    expect(Object.keys(table.board!.hands).sort()).toEqual(['E', 'N', 'S', 'W'])
    // Seen, not bid for: the bidding box is still South's alone
    expect(table.acts).toBeUndefined()
    await send(amy, { type: 'showHands', show: false })
    table = view(amy)!
    expect(table.practice?.showHands).toBeUndefined()
    expect(Object.keys(table.board!.hands)).toEqual(['S'])

    // Only the table's member, only at a practice table
    await send(amy, { type: 'updateTableSettings', settings: { access: 'public' } })
    await send(ben, { type: 'joinTable', tableId: table.id })
    expect((await refused(ben, { type: 'showHands', show: true }))?.code).toBe('hostOnly')
    const cat = await member('cat')
    await send(cat, { type: 'createTable' })
    expect((await refused(cat, { type: 'showHands', show: true }))?.code).toBe('practiceOnly')
    expect(parseClientMessage('{"type":"showHands","show":"yes"}')).toEqual({ error: 'badMessage' })
  })

  it('can start shown, and is kept with the settings', async () => {
    const amy = await member('amy')
    expect(parsePracticeSettings({ showHands: true })).toEqual({
      settings: { deal: 'random', robotKind: 'gib', justDeclare: false, showHands: true },
    })
    expect(parsePracticeSettings({ showHands: 1 })).toEqual({ field: 'showHands' })
    await practice(amy, { showHands: true })
    expect(Object.keys(view(amy)!.board!.hands)).toHaveLength(4)
  })
})

describe('saved practice settings (存成我的設定, e10-t16)', () => {
  it('saves settings by name, replaces them under the same name, deletes them, and keeps each member’s own', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const settings = { deal: 'custom', conditions: { seats: { S: { hcp: [15, 17], balanced: true } } }, biddingOnly: true }
    let presets = await club.savePractice(amy, { name: '  1NT 開叫 ', settings })
    expect(presets).toMatchObject([{ name: '1NT 開叫', settings: { ...settings, robotKind: 'gib', justDeclare: false } }])
    const id = presets[0].id
    presets = await club.savePractice(amy, { name: '1NT 開叫', settings: { deal: 'slam' } })
    expect(presets).toHaveLength(1)
    expect(presets[0]).toMatchObject({ id, settings: { deal: 'slam' } })
    expect(await club.savedPractice(ben)).toEqual([])
    await expect(club.removeSavedPractice(ben, id)).rejects.toMatchObject({ code: 'presetGone' })

    // Checked as a new table is
    await expect(club.savePractice(amy, { name: '', settings })).rejects.toMatchObject({ code: 'badPresetName' })
    await expect(club.savePractice(amy, { name: 'x'.repeat(31), settings })).rejects.toMatchObject({ code: 'badPresetName' })
    await expect(club.savePractice(amy, { name: 'bad', settings: { deal: 'nope' } })).rejects.toMatchObject({
      code: 'badPracticeSettings',
      params: { field: 'deal' },
    })
    await expect(
      club.savePractice(amy, { name: 'bad', settings: { deal: 'custom', conditions: { seats: { S: { balanced: true, shortest: [0, 0] } } } } }),
    ).rejects.toMatchObject({ code: 'dealConflict' })

    // At most PRACTICE_PRESETS_MAX
    for (let i = 1; i < PRACTICE_PRESETS_MAX; i++) {
      time += 60_000
      await club.savePractice(amy, { name: `set ${i}`, settings: { deal: 'random' } })
    }
    expect(await club.savedPractice(amy)).toHaveLength(PRACTICE_PRESETS_MAX)
    await expect(club.savePractice(amy, { name: 'one more', settings: {} })).rejects.toMatchObject({
      code: 'practicePresetsFull',
      params: { max: PRACTICE_PRESETS_MAX },
    })
    // Newest first
    expect((await club.savedPractice(amy))[0].name).toBe(`set ${PRACTICE_PRESETS_MAX - 1}`)
    expect(await club.removeSavedPractice(amy, id)).toHaveLength(PRACTICE_PRESETS_MAX - 1)

    // Gone with the account
    await club.adminDeleteUser(boss, amy)
    expect(store.data.has(`practicePresets:${amy}`)).toBe(false)
  })
})

describe('deal sets (e10-t16)', () => {
  it('lists every practice set file, well formed, with its boards’ dealer and vulnerability', () => {
    expect(PRACTICE_SET_ERRORS).toEqual([])
    expect(practiceSetInfos().find((s) => s.id === 'sample')).toEqual({
      id: 'sample',
      count: 3,
      categories: ['notrump', 'competitive', 'slam'],
    })
    for (const set of PRACTICE_SETS.values()) expect(set.problems.length).toBeGreaterThan(0)
    for (const seat of SEATS)
      for (const vul of ['None', 'NS', 'EW', 'Both'] as const) {
        const n = boardNoFor(seat, vul)
        expect([dealerOf(n), vulnerabilityOf(n)]).toEqual([seat, vul])
      }
    const good = { id: 'a', dealer: 'N', vulnerability: 'All', hands: 'N:AK5.KQ6.A84.QJ32 T98.T98.JT97.K98 QJ72.AJ7.KQ62.A4 643.5432.53.T765', category: 'slam', note: '' }
    const loaded = loadPracticeSets({
      './good.json': [good],
      './bad.json': [{ ...good, hands: 'N:AK5.KQ6.A84.QJ32' }],
      './twice.json': [good, good],
      './empty.json': [],
    })
    expect([...loaded.sets.keys()]).toEqual(['good'])
    expect(loaded.sets.get('good')!.problems[0].boardNo).toBe(13)
    expect(loaded.errors).toHaveLength(3)
  })

  it('keeps the sets’ hands out of the browser: nothing in src/ imports them, only their types', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
      )
    for (const file of files('src')) expect(readFileSync(file, 'utf8'), file).not.toMatch(/practice-sets\/(index|[\w-]+\.json)/)
  })

  it('deals a practice set’s boards in turn, and tells what each teaches once the auction is over', async () => {
    const amy = await member('amy')
    await practice(amy, { deal: 'set', set: { source: 'practice', id: 'sample' }, biddingOnly: true, seats: ['S', 'N'] })
    const sample = PRACTICE_SETS.get('sample')!.problems
    for (let i = 0; i < 4; i++) {
      const expected = sample[i % 3]
      let table = view(amy)!
      expect(table.board!.boardNo).toBe(expected.boardNo)
      expect(table.board!.hands.S).toEqual(expected.hands.S)
      expect(table.board!.hands.E).toBeUndefined()
      expect(table.practice?.problem).toEqual({ seq: (i % 3) + 1, count: 3, category: expected.category })
      // The hands of the set never go with the settings
      expect(JSON.stringify(table.practice)).not.toContain(expected.hands.E[0] + expected.hands.E[1])
      await passOut(amy)
      table = view(amy)!
      expect(table.practice?.problem?.note).toBe(expected.note)
      await send(amy, { type: 'redeal' })
    }
    expect((await refused(amy, { type: 'createPractice', settings: { deal: 'set', set: { source: 'practice', id: 'nope' } } } as unknown as ClientMessage))?.code).toBe(
      'practiceSetGone',
    )
    expect(parsePracticeSettings({ deal: 'set', set: { source: 'practice', id: 'sample' }, justDeclare: true })).toEqual({ field: 'justDeclare' })
    expect(parsePracticeSettings({ deal: 'set' })).toEqual({ field: 'set' })
    expect(parsePracticeSettings({ deal: 'random', set: { source: 'practice', id: 'sample' } })).toEqual({ field: 'set' })
    expect(parsePracticeSettings({ deal: 'set', set: { source: 'favorites', ids: [] } })).toEqual({ field: 'set' })
  })

  it('deals boards of the member’s own favourites and of the featured list, and none that is not theirs or not featured', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    // A practice board of amy's, kept as a favourite
    await practice(amy)
    await playBoard(amy)
    const mine = view(amy)!.recent[0].id
    await club.saveFavorite(amy, mine, { note: '', tags: [] })
    // A casual board of the founder's, featured
    await send(boss, { type: 'createTable' })
    for (const seat of ['N', 'E', 'W'] as const) await send(boss, { type: 'addRobot', seat })
    await playBoard(boss)
    const casual = view(boss)!.recent[0].id
    await club.featured.set(boss, casual, { title: '好牌', category: 'bidding', explanation: '先叫高花' })

    await practice(amy, { deal: 'set', set: { source: 'favorites', ids: [mine] }, biddingOnly: true })
    const record = (await club.record(mine, amy))!
    expect(view(amy)!.board).toMatchObject({ boardNo: record.board.boardNo, hands: { S: record.board.hands.S } })

    await practice(ben, { deal: 'set', set: { source: 'featured', ids: [casual] }, biddingOnly: true })
    expect(view(ben)!.practice?.problem).toEqual({ seq: 1, count: 1, category: 'bidding', title: '好牌' })
    expect(view(ben)!.board!.hands.S).toEqual((await club.record(casual, ben))!.board.hands.S)
    await passOut(ben)
    expect(view(ben)!.practice?.problem?.note).toBe('先叫高花')

    // Not ben's favourite; not featured
    const gone = async (userId: string, set: unknown) =>
      (await refused(userId, { type: 'createPractice', settings: { deal: 'set', set } } as unknown as ClientMessage))?.code
    expect(await gone(ben, { source: 'favorites', ids: [mine] })).toBe('boardGone')
    expect(await gone(ben, { source: 'featured', ids: [mine] })).toBe('boardGone')
    expect(await gone(ben, { source: 'featured', ids: ['nothing'] })).toBe('boardGone')
  })
})
