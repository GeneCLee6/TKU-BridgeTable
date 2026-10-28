// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardRecord, Me } from '../../shared/protocol.ts'
import { robotId, SYSTEM_SPEC_LIMITS } from '../../shared/protocol.ts'
import { auctionPattern, bookKey, type BookNotes } from '../../shared/robot/system/book-spec.ts'
import type { SystemSpec } from '../../shared/systemSpec.ts'
import { ClubError } from '../../worker/errors.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import { manualScheduler, type JobKind } from '../../worker/scheduler.ts'
import { MemoryStore } from '../../worker/store.ts'
import { robotMeaningsFor, SystemSpecStore } from '../../worker/system-spec.ts'
import { TableService } from '../../worker/table-service.ts'

/** 淡江橋館's rules synced for TKB (BridgeHall e7-t03) and the report page's lookups (e7-t04) */

const editor = { id: 'ed1', username: 'ed' } as Me

const spec = (version = 1, profileId = 'club'): SystemSpec => ({
  profileId,
  version,
  rules: [
    {
      after: ['1N (P)'],
      call: '2C',
      shows: { name: 'stayman', hcp: [8, 40] },
      text: 'Stayman，8點↑',
      ref: { slug: 'notrump-responses', sectionId: 'stayman' },
    },
  ],
  unresolved: [{ ref: { slug: 'notrump-responses', sectionId: 'x' }, call: '2D', text: '轉換', reason: 'noConditions' }],
})

describe('SystemSpecStore', () => {
  let store: MemoryStore
  let time: number
  let specs: SystemSpecStore

  beforeEach(() => {
    store = new MemoryStore()
    time = 1000
    specs = new SystemSpecStore(store, () => time)
  })

  it('keeps the last synced spec of each profile, with when and by whom', async () => {
    expect(await specs.get('club')).toBeNull()
    await specs.save(editor, 'club', { spec: spec(1) })
    time = 2000
    await specs.save(editor, 'club', { spec: spec(2) })
    expect(await specs.get('club')).toEqual({ spec: spec(2), syncedAt: 2000, syncedBy: 'ed1' })
    // In the daily backup with the rest of the book
    expect([...store.data.keys()].every((key) => key.startsWith('book'))).toBe(true)
  })

  it('keeps a large spec in parts', async () => {
    const big = spec(1)
    big.rules = Array.from({ length: 2000 }, (_, i) => ({ ...big.rules[0], text: `${i} ${'字'.repeat(100)}` }))
    await specs.save(editor, 'club', { spec: big })
    expect((await specs.get('club'))!.spec.rules).toHaveLength(2000)
  })

  it('refuses a spec of the wrong shape or for another profile', async () => {
    await expect(specs.save(editor, 'club', {})).rejects.toThrow(ClubError)
    await expect(specs.save(editor, 'club', { spec: spec(1, 'team1') })).rejects.toThrow(ClubError)
    await expect(specs.save(editor, 'club', { spec: { ...spec(), rules: [{ after: '1N', call: '2C' }] } })).rejects.toThrow(ClubError)
    const badRange = spec()
    ;(badRange.rules[0].shows as Record<string, unknown>).hcp = [8]
    await expect(specs.save(editor, 'club', { spec: badRange })).rejects.toThrow(ClubError)
    const huge = spec()
    huge.rules[0].text = '字'.repeat(SYSTEM_SPEC_LIMITS.bytesMax)
    await expect(specs.save(editor, 'club', { spec: huge })).rejects.toMatchObject({ status: 413 })
    expect(await specs.get('club')).toBeNull()
  })

  it('hands the tables the words of the profile TKB follows, and says when they have them', async () => {
    expect(await specs.bookNotes(null)).toBeNull()
    await specs.save(editor, 'club', { spec: spec(1) })
    const notes = (await specs.bookNotes(null)) as BookNotes
    expect(notes.notes[bookKey('1N (P)', '2C')].text).toBe('Stayman，8點↑')
    expect(await specs.bookNotes(notes.key)).toBe('same')
    // Another profile's sync changes nothing for the tables
    await specs.save(editor, 'team1', { spec: spec(5, 'team1') })
    expect(await specs.bookNotes(notes.key)).toBe('same')
    time = 3000
    await specs.save(editor, 'club', { spec: spec(2) })
    expect(await specs.bookNotes(notes.key)).not.toBe('same')
  })

  it('follows the profile it is given', async () => {
    specs = new SystemSpecStore(store, () => time, 'team1')
    await specs.save(editor, 'club', { spec: spec(1) })
    expect(await specs.bookNotes(null)).toBeNull()
    await specs.save(editor, 'team1', { spec: spec(1, 'team1') })
    expect(await specs.bookNotes(null)).toMatchObject({ key: expect.stringMatching(/^team1:1:/) })
  })
})

describe('robot meanings for the report page', () => {
  it('answers a few auctions at a time', () => {
    const [item] = robotMeaningsFor({ items: [{ after: '', calls: ['1N'] }] })
    expect(item.meanings['1N']).toMatchObject({ hcp: [15, 17] })
    const many = Array.from({ length: SYSTEM_SPEC_LIMITS.meaningItemsMax + 1 }, () => ({ after: '', calls: ['1N'] }))
    expect(() => robotMeaningsFor({ items: many })).toThrow(ClubError)
    expect(() => robotMeaningsFor({ items: [{ after: '', calls: ['9N'] }] })).toThrow(ClubError)
    expect(() => robotMeaningsFor({})).toThrow(ClubError)
  })

  it('is the editors’', () => {
    expect(bookRouteNeed('GET', '/system-spec')).toBe('bookEdit')
    expect(bookRouteNeed('PUT', '/system-spec/club')).toBe('bookEdit')
    expect(bookRouteNeed('POST', '/robot-meanings')).toBe('bookEdit')
    expect(bookRouteNeed('DELETE', '/system-spec/club')).toBeNull()
    expect(bookRouteNeed('GET', '/robot-meanings')).toBeNull()
  })
})

describe('TKB with the handbook’s words', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('puts the words on its calls, asking the club once a board', async () => {
    const queue: { run: () => void; kind: JobKind }[] = []
    const finished: BoardRecord[] = []
    const asked: (string | null)[] = []
    // Words for every call after every auction, naming both
    const notes: BookNotes = {
      key: 'k1',
      notes: new Proxy({}, { get: (_, key) => ({ text: `book ${String(key)}`, slug: 's', sectionId: 'x' }) }),
    }
    const store = new MemoryStore()
    const table = new TableService(
      'tbl1',
      { save: (t) => store.put(`table:${t.id}`, t), remove: (id) => store.delete(`table:${id}`) },
      { onlineUserIds: () => ['amy'], send: () => {} },
      {
        changed: () => {},
        closed: () => {},
        boardFinished: async (record) => void finished.push(record),
        mayUseTku: () => true,
        bookNotes: async (known) => {
          asked.push(known)
          return known === notes.key ? 'same' : notes
        },
      },
      { now: () => 1_000_000, random: (n) => Math.floor(n / 2), scheduler: manualScheduler((run, _ms, kind) => queue.push({ run, kind })) },
    )
    await table.open({
      id: 'tbl1',
      number: 1,
      hostId: 'amy',
      seats: { N: robotId('tku', 'N'), E: robotId('tku', 'E'), S: 'amy', W: robotId('tku', 'W') },
      spectators: [],
      boardsPlayed: 0,
      board: null,
      chat: [],
      createdAt: 1_000_000,
      mode: 'casual',
      names: { amy: 'amy' },
      blocks: { amy: [] },
    })
    for (let i = 0; i < 2000 && !finished.length; i++) {
      const index = queue.findIndex((job) => job.kind === 'robot')
      if (index >= 0) {
        queue.splice(index, 1)[0].run()
        await tick()
        continue
      }
      const view = table.view('amy')!.board!
      if (view.phase === 'finished') break
      if (view.legalCalls.length) await table.act('amy', { type: 'call', call: 'P' })
      else if (view.legalCards.length) await table.act('amy', { type: 'play', card: view.legalCards[0] })
    }
    expect(finished.length).toBeGreaterThan(0)
    const auction = finished[0].board.auction
    const robotCalls = auction.filter((c) => c.robot && c.call !== 'P')
    for (const call of robotCalls) {
      const before = auction.slice(0, auction.indexOf(call))
      expect(call.book).toEqual({ text: `book ${bookKey(auctionPattern(before), call.call)}`, slug: 's', sectionId: 'x' })
    }
    // Pass carries no words, as it carries no alert; a person's call none either
    expect(auction.filter((c) => !c.robot || c.call === 'P').every((c) => !c.book)).toBe(true)
    expect(robotCalls.length).toBeGreaterThan(1)
    // Once for the board, however many calls TKB made
    expect(asked).toEqual([null])
  })
})
