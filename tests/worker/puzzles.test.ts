// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Card, type Seat } from '../../shared/cards.ts'
import { hashText, puzzleRevision } from '../../shared/puzzle-solver.ts'
import { PUZZLES, type Puzzle } from '../../shared/puzzle-sets/index.ts'
import { legalPlays, puzzleEdges, puzzleState, splitCards, type PuzzleView } from '../../shared/puzzles.ts'
import { AuditLog } from '../../worker/audit.ts'
import { hashPassword } from '../../worker/auth.ts'
import { ClubError } from '../../worker/errors.ts'
import { PuzzleService } from '../../worker/puzzles.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

/** 謎題 (`e10-t13`, `e10-t14`, AC-10.9): drafts until published, every card checked, hidden hands, progress, the account */

class Sockets implements Connections {
  onlineUserIds() {
    return []
  }
  send() {}
  disconnect() {}
}

const code = async (run: () => unknown) => {
  try {
    await run()
  } catch (error) {
    return error instanceof ClubError ? error.code : String(error)
  }
  return 'no error'
}

let store: MemoryStore
let club: ClubService
let boss: string
let amy: string
let time: number

const first = PUZZLES[0]

/** A member's card, with time to spare for the action limit */
const play = (who: string, id: string, card: unknown) => {
  time += 60_000
  return club.puzzles.play(who, id, card)
}

async function make(clubId = 'tku') {
  const s = memoryStore()
  const c = new ClubService(s, new Sockets(), { clubId, maxUsers: 40, schedule: () => {}, now: () => time })
  await c.load()
  if (clubId !== 'tku') await c.provisionFounder('boss', await hashPassword('club-secret-1'))
  const signedIn = clubId === 'tku' ? await c.register('boss', 'club-secret-1', '') : await c.login('boss', 'club-secret-1', '', '')
  if (!('user' in signedIn)) throw new Error('the first account should sign in')
  await adminWithTwoFactor(c, signedIn.user.id)
  const member = await c.adminCreateUser('amy', 'club-secret-1')
  return { store: s, club: c, boss: signedIn.user.id, amy: member.id }
}

beforeEach(async () => {
  time = 1_000_000
  ;({ store, club, boss, amy } = await make())
})

const publish = (puzzle: Puzzle = first) => club.adminSetPuzzlePublished(boss, puzzle.source.id, true)

/** Right cards from where the member is to solved: the first listed each time */
function rightLine(puzzle: Puzzle): Card[] {
  const cards: Card[] = []
  for (let node = 0; node >= 0; ) {
    const [edge] = puzzleEdges(puzzle.solution, node)
    cards.push(edge.card)
    node = edge.next
  }
  return cards
}

/** A legal card the stored data does not list at the first decision with one */
function firstWrong(puzzle: Puzzle): { before: Card[]; wrong: Card } {
  const before: Card[] = []
  const played = [...puzzle.source.opening, ...splitCards(puzzle.solution.start)]
  for (let node = 0; node >= 0; ) {
    const edges = puzzleEdges(puzzle.solution, node)
    const wrong = legalPlays(puzzleState(puzzle.source, played)).find((card) => !edges.some((e) => e.card === card))
    if (wrong) return { before, wrong }
    before.push(edges[0].card)
    played.push(edges[0].card, ...edges[0].replies)
    node = edges[0].next
  }
  throw new Error(`${puzzle.source.id} has no wrong card`)
}

/** What the wire may never carry while the attempt is not solved: the defenders' cards still in their hands */
function unplayedDefenderCards(puzzle: Puzzle, played: readonly Card[]) {
  const state = puzzleState(puzzle.source, [...puzzle.source.opening, ...played])
  return [...state.hands.E, ...state.hands.W]
}

/** Whether the view holds the card as a card of a hand, the trick or the gone list */
const onWire = (view: unknown, cards: readonly Card[]) => cards.filter((card) => JSON.stringify(view).includes(`"${card}"`))

describe('drafts reach nobody until an admin publishes (e10-t13)', () => {
  it('a member sees no puzzle, and cannot open or play a draft', async () => {
    expect(PUZZLES).toHaveLength(10)
    expect(club.puzzles.list(amy)).toEqual([])
    for (const puzzle of PUZZLES) {
      expect(await code(() => club.puzzles.get(amy, puzzle.source.id))).toBe('puzzleGone')
      expect(await code(() => club.puzzles.play(amy, puzzle.source.id, rightLine(puzzle)[0]))).toBe('puzzleGone')
      expect(await code(() => club.puzzles.hint(amy, puzzle.source.id))).toBe('puzzleGone')
      expect(await code(() => club.puzzles.retry(amy, puzzle.source.id, 'start'))).toBe('puzzleGone')
    }
  })

  it('only an admin reads and publishes, each one on its own, in the audit log', async () => {
    expect(await code(() => club.adminPuzzles(amy))).toBe('adminOnly')
    expect(await code(() => club.adminSetPuzzlePublished(amy, first.source.id, true))).toBe('adminOnly')
    expect(club.adminPuzzles(boss).every((puzzle) => puzzle.status === 'draft')).toBe(true)

    const after = await publish()
    expect(after.filter((puzzle) => puzzle.status === 'published').map((puzzle) => puzzle.id)).toEqual([first.source.id])
    expect(after[0].publishedBy).toBe('boss')
    expect(club.puzzles.list(amy).map((puzzle) => puzzle.id)).toEqual([first.source.id])

    // Publishing twice records nothing more
    await publish()
    const audit = new AuditLog(store, () => time)
    const actions = () => audit.list().then((entries) => entries.filter((e) => e.action.startsWith('puzzle:')))
    expect((await actions()).map((e) => [e.action, e.by, e.target])).toEqual([['puzzle:publish', 'boss', `${first.source.id}@${first.solution.revision}`]])

    await club.adminSetPuzzlePublished(boss, first.source.id, false)
    expect(club.puzzles.list(amy)).toEqual([])
    expect(await code(() => club.puzzles.get(amy, first.source.id))).toBe('puzzleGone')
    expect((await actions()).map((e) => e.action).sort()).toEqual(['puzzle:publish', 'puzzle:unpublish'])
  })

  it('the admin reads everything: all four hands, the hints, the explanation, a line', () => {
    const [view] = club.adminPuzzles(boss)
    const hands = puzzleState(first.source, []).hands
    expect(view.hands).toEqual(hands)
    expect(view.hints).toEqual(first.source.hints)
    expect(view.explanation).toBe(first.source.explanation)
    expect(view.line.length).toBeGreaterThan(0)
  })

  it('an unknown puzzle, and a publish that says neither', async () => {
    expect(await code(() => club.adminSetPuzzlePublished(boss, 'nope', true))).toBe('puzzleGone')
    expect(await code(() => club.adminSetPuzzlePublished(boss, first.source.id, 'yes'))).toBe('puzzleNothingToRetry')
  })

  it('publishing in one club does nothing in another', async () => {
    await publish()
    const other = await make('other')
    expect(other.club.puzzles.list(other.amy)).toEqual([])
    expect(other.club.adminPuzzles(other.boss).every((puzzle) => puzzle.status === 'draft')).toBe(true)
  })

  it('a new version of a puzzle is a draft again, and an attempt on the old one starts over', async () => {
    const audit = new AuditLog(store, () => time)
    const service = (revision: string) =>
      new PuzzleService({
        sql: store.sql,
        now: () => time,
        audit,
        takeAction: () => true,
        puzzles: [{ source: first.source, solution: { ...first.solution, revision } }],
      })
    const old = service('old')
    await old.setPublished('boss', first.source.id, true)
    old.play(amy, first.source.id, rightLine(first)[0])
    expect(old.get(amy, first.source.id).status).not.toBe('new')

    const changed = service('new')
    expect(changed.list(amy)).toEqual([])
    expect(changed.adminList()[0].status).toBe('draft')
    await changed.setPublished('boss', first.source.id, true)
    expect(changed.get(amy, first.source.id).status).toBe('new')
    expect(hashText(first.source.deal)).not.toBe(puzzleRevision(first.source))
  })
})

describe('playing (e10-t14): the server checks each card from the stored data', () => {
  beforeEach(async () => {
    for (const puzzle of PUZZLES) await publish(puzzle)
  })

  it('only legal cards of the seat to play, and only strings', async () => {
    const view = club.puzzles.get(amy, first.source.id)
    expect(view.turn === 'N' || view.turn === 'S').toBe(true)
    const other = view.turn === 'N' ? 'S' : 'N'
    const notNow = view.hands[other]?.find((card) => !view.legalCards.includes(card))
    expect(await code(() => club.puzzles.play(amy, first.source.id, notNow))).toBe('puzzleIllegalCard')
    expect(await code(() => club.puzzles.play(amy, first.source.id, 'XX'))).toBe('puzzleIllegalCard')
    expect(await code(() => club.puzzles.play(amy, first.source.id, 7))).toBe('puzzleIllegalCard')
    expect(await code(() => club.puzzles.play(amy, first.source.id, view.legalCards.join('')))).toBe('puzzleIllegalCard')
  })

  it('every puzzle can be solved along its stored data, and defenders\' cards stay hidden until then', () => {
    for (const puzzle of PUZZLES) {
      const id = puzzle.source.id
      let view: PuzzleView = club.puzzles.get(amy, id)
      expect(view.status).toBe('new')
      const played: Card[] = [...splitCards(puzzle.solution.start)]
      expect(onWire(view, unplayedDefenderCards(puzzle, played))).toEqual([])
      for (let node = 0; node >= 0; ) {
        expect(view.status === 'solved').toBe(false)
        expect(view.hands.E).toBeUndefined()
        expect(view.hands.W).toBeUndefined()
        expect(view.startHands).toBeUndefined()
        expect(view.explanation).toBeUndefined()
        expect(onWire(view, unplayedDefenderCards(puzzle, played))).toEqual([])
        const [edge] = puzzleEdges(puzzle.solution, node)
        view = play(amy, id, edge.card)
        played.push(edge.card, ...edge.replies)
        node = edge.next
      }
      expect(view.status).toBe('solved')
      expect(view.solved).toBe(true)
      expect(view.clean).toBe(true)
      expect(view.turn).toBeNull()
      expect(view.legalCards).toEqual([])
      expect(view.explanation).toBe(puzzle.source.explanation)
      // Once solved, everything: all four hands as they started
      const startHands = puzzleState(puzzle.source, []).hands
      expect(view.startHands).toEqual(startHands)
      for (const seat of SEATS) expect(view.hands[seat]).toBeDefined()
    }
  })

  it('a wrong card ends the attempt with nothing applied; the member takes it back or starts over', async () => {
    const puzzle = PUZZLES.find((p) => p.source.id === 'p08')!
    const id = puzzle.source.id
    const { before, wrong } = firstWrong(puzzle)
    for (const card of before) play(amy, id, card)
    const standing = club.puzzles.get(amy, id)

    const failed = club.puzzles.play(amy, id, wrong)
    expect(failed.status).toBe('failed')
    expect(failed.wrong).toBe(wrong)
    expect(failed.failures).toBe(1)
    expect(failed.legalCards).toEqual([])
    // It says nothing about where the defenders' cards are
    expect(failed.hands.E).toBeUndefined()
    expect(failed.explanation).toBeUndefined()
    expect(failed.tricks).toEqual(standing.tricks)
    expect(failed.hands).toEqual(standing.hands)
    expect(await code(() => club.puzzles.play(amy, id, standing.legalCards[0]))).toBe('puzzleAttemptOver')

    const back = club.puzzles.retry(amy, id, 'mistake')
    expect(back.status).toBe('playing')
    expect(back.wrong).toBeNull()
    expect(back.legalCards).toEqual(standing.legalCards)
    expect(await code(() => club.puzzles.retry(amy, id, 'mistake'))).toBe('puzzleNothingToRetry')
    expect(await code(() => club.puzzles.retry(amy, id, 'sideways'))).toBe('puzzleNothingToRetry')

    const again = club.puzzles.retry(amy, id, 'start')
    expect(again.tricks).toHaveLength(0)
    expect(again.failures).toBe(1)

    // Solved after a mistake counts as solved, not as clean, and stays so
    for (const card of rightLine(puzzle)) play(amy, id, card)
    const solved = club.puzzles.list(amy).find((p) => p.id === id)
    expect(solved).toMatchObject({ solved: true, clean: false, status: 'solved' })
  })

  it('playing a solved puzzle again hides the defenders\' cards again and keeps the progress', () => {
    const puzzle = PUZZLES.find((p) => p.source.id === 'p10')!
    const id = puzzle.source.id
    time = 5_000
    for (const card of rightLine(puzzle)) play(amy, id, card)
    expect(club.puzzles.get(amy, id).hands.E).toBeDefined()

    const replay = club.puzzles.retry(amy, id, 'start')
    expect(replay.status).toBe('playing')
    expect(replay.hands.E).toBeUndefined()
    expect(replay.startHands).toBeUndefined()
    expect(replay.explanation).toBeUndefined()
    expect(replay.solved).toBe(true)
    expect(replay.clean).toBe(true)
    expect(onWire(replay, unplayedDefenderCards(puzzle, splitCards(puzzle.solution.start)))).toEqual([])
    const list = club.puzzles.list(amy).find((p) => p.id === id)
    expect(list).toMatchObject({ solved: true, clean: true, status: 'playing' })
  })

  it('the list has no cards, and hints come one at a time and count', async () => {
    const list = club.puzzles.list(amy)
    expect(list).toHaveLength(10)
    expect(new Set(list.map((puzzle) => puzzle.level))).toEqual(new Set([1, 2, 3]))
    for (const puzzle of PUZZLES) expect(onWire(list, [...puzzleState(puzzle.source, []).hands.E, ...puzzleState(puzzle.source, []).hands.N])).toEqual([])

    const id = first.source.id
    const given: string[] = []
    expect(club.puzzles.get(amy, id).hints).toEqual([])
    for (const hint of first.source.hints) {
      given.push(hint)
      const view = club.puzzles.hint(amy, id)
      expect(view.hints).toEqual(given)
    }
    expect(await code(() => club.puzzles.hint(amy, id))).toBe('puzzleNoMoreHints')
    for (const card of rightLine(first)) play(amy, id, card)
    expect(club.puzzles.list(amy).find((p) => p.id === id)).toMatchObject({ solved: true, clean: false })
  })

  it('one member\'s progress is not another\'s', async () => {
    const ben = (await club.adminCreateUser('ben', 'club-secret-1')).id
    club.puzzles.play(amy, first.source.id, rightLine(first)[0])
    expect(club.puzzles.get(ben, first.source.id).status).toBe('new')
  })

  it('stays out of the records, the rankings and the points', async () => {
    type Export = { boards: unknown; points: unknown; rating: unknown; puzzles: unknown[] }
    const before = (await club.exportAccount(amy, null)) as unknown as Export
    for (const card of rightLine(first)) play(amy, first.source.id, card)
    const after = (await club.exportAccount(amy, null)) as unknown as Export
    expect(after.boards).toEqual(before.boards)
    expect(after.points).toEqual(before.points)
    expect(after.rating).toEqual(before.rating)
    expect(after.puzzles).toHaveLength(1)
  })

  it('a card is well inside 10 ms of CPU, on the biggest stored data', () => {
    const biggest = PUZZLES.reduce((a, b) => (b.solution.nodes.length > a.solution.nodes.length ? b : a))
    const service = new PuzzleService({ sql: store.sql, now: () => time, audit: new AuditLog(store, () => time), takeAction: () => true })
    const started = performance.now()
    let plays = 0
    for (let round = 0; round < 20; round++) {
      for (const card of rightLine(biggest)) {
        service.play(amy, biggest.source.id, card)
        plays++
      }
      service.retry(amy, biggest.source.id, 'start')
      plays++
    }
    // The logic alone, on an in-memory database: far under the budget even on a busy machine
    expect((performance.now() - started) / plays).toBeLessThan(5)
  })
})

describe('the account (e10-t14)', () => {
  beforeEach(async () => {
    await publish()
  })

  it('the export has the progress, also of a puzzle taken back', async () => {
    time = 2_000
    club.puzzles.play(amy, first.source.id, rightLine(first)[0])
    await club.adminSetPuzzlePublished(boss, first.source.id, false)
    const exported = (await club.exportAccount(amy, null)) as unknown as { puzzles: Record<string, unknown>[] }
    expect(exported.puzzles).toHaveLength(1)
    expect(exported.puzzles[0]).toMatchObject({ puzzleId: first.source.id, status: 'playing', hints: 0, failures: 0, attempts: 1, solvedAt: null, updatedAt: 2_000 })
    expect(exported.puzzles[0].node).toBeUndefined()
    expect(exported.puzzles[0].revision).toBeUndefined()
  })

  it('deleting the account deletes the progress, and only theirs', async () => {
    const ben = (await club.adminCreateUser('ben', 'club-secret-1')).id
    club.puzzles.play(amy, first.source.id, rightLine(first)[0])
    club.puzzles.play(ben, first.source.id, rightLine(first)[0])
    await club.adminDeleteUser(boss, amy)
    const rows = store.sql.exec<{ user_id: string }>('SELECT user_id FROM puzzle_progress')
    expect(rows.map((row) => row.user_id)).toEqual([ben])
    expect(club.puzzles.exportOf(amy)).toEqual([])
  })

  it('a restored backup drops the progress of someone no longer a member', () => {
    club.puzzles.play(amy, first.source.id, rightLine(first)[0])
    club.puzzles.reload((id) => id !== amy)
    expect(club.puzzles.exportOf(amy)).toEqual([])
  })

  it('every seat name stays a seat', () => {
    const seats: Seat[] = ['N', 'S']
    expect(Object.keys(club.puzzles.get(amy, first.source.id).hands).sort()).toEqual(seats)
  })
})
