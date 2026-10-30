// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientMessage } from '../../shared/protocol.ts'
import { at, teamHarness } from './team-match-harness.ts'

/**
 * The Vugraph page of a team match (e8-t18, e8-t19, AC-8.8, ARCHITECTURE.md §4 and §5.8): both
 * rooms side by side for anyone who does not play in it, the score, the watchers' chat that never
 * reaches a player, and the match that plays one trick behind for its watchers, done on the server
 */

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

/** A match of four boards: Amy in the open room's South, Ben in the closed room's South, robots elsewhere */
async function started({ delay = false } = {}) {
  const m = await t.match({ boards: 4, seats: { ben: at('closed', 'S') } })
  if (delay) t.club().matches.update(m.amy, m.id, { delay: true })
  await t.send(m.amy, { type: 'startMatch', matchId: m.id })
  return { ...m, open: t.tableIdOf(m.id, 'open'), closed: t.tableIdOf(m.id, 'closed') }
}

const vugraph = (userId: string, matchId: string) => t.club().matchVugraph(userId, matchId)
const cardsShown = (board: { tricks: { cards: unknown[] }[] } | null | undefined) =>
  (board?.tricks ?? []).reduce((n, trick) => n + trick.cards.length, 0)
const played = (tableId: string) => t.tableState(tableId)?.board?.play.length ?? 0

describe('the Vugraph page (e8-t18)', () => {
  it('shows a watcher both rooms with all four hands and the score, and never a player', async () => {
    const { id, amy, people, open, closed } = await started()
    const cat = await t.member('cat')
    const page = await vugraph(cat, id)
    expect(page.match.id).toBe(id)
    expect(page.rooms.open!.tableId).toBe(open)
    expect(page.rooms.closed!.tableId).toBe(closed)
    for (const room of [page.rooms.open!, page.rooms.closed!]) {
      expect(Object.keys(room.board!.hands)).toHaveLength(4)
      expect(room.board!.legalCalls).toEqual([])
      expect(room.match.seq).toBe(1)
    }
    expect(page.rooms.closed!.seats.S?.id).toBe(people.ben)
    // Neither the host nor a player of either room may look, and the same answer over the tables' own lists
    await expect(vugraph(amy, id)).rejects.toMatchObject({ code: 'matchNoWatching' })
    await expect(vugraph(people.ben, id)).rejects.toMatchObject({ code: 'matchNoWatching' })
    await expect(t.club().localTable(open)!.vugraph(people.ben)).rejects.toMatchObject({ code: 'matchNoWatching' })
    await expect(t.club().localTable(closed)!.vugraph(amy)).rejects.toMatchObject({ code: 'matchNoWatching' })
  })

  it('keeps a match being set up from everyone outside it, and shows a finished one without rooms', async () => {
    const m = await t.match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const cat = await t.member('cat')
    await expect(vugraph(cat, m.id)).rejects.toMatchObject({ code: 'matchGone' })
    await expect(vugraph(m.amy, m.id)).rejects.toMatchObject({ code: 'matchNoWatching' })
    await t.send(m.amy, { type: 'startMatch', matchId: m.id })
    await t.playUntil([m.amy, m.people.ben], () => t.club().matches.store.get(m.id)!.status === 'finished')
    const page = await vugraph(cat, m.id)
    expect(page.rooms).toEqual({})
    expect(page.match.status).toBe('finished')
    // Once it is over the players may read it too
    expect((await vugraph(m.amy, m.id)).match.boards).toHaveLength(4)
  })

  it('keeps the watchers’ chat from the players, and keeps a watcher from coming in as a substitute', async () => {
    const { id, amy, people } = await started()
    const cat = await t.member('cat')
    const dan = await t.member('dan')
    await t.club().matchVugraphChat(cat, id, '  the closed room went down  ')
    const page = await vugraph(dan, id)
    expect(page.chat).toMatchObject([{ userId: cat, username: 'cat', text: 'the closed room went down' }])
    await expect(t.club().matchVugraphChat(amy, id, 'hi')).rejects.toMatchObject({ code: 'matchNoWatching' })
    await expect(t.club().matchVugraphChat(people.ben, id, 'hi')).rejects.toMatchObject({ code: 'matchNoWatching' })
    for (const userId of [amy, people.ben]) expect(JSON.stringify(t.h.connections.inbox.get(userId))).not.toContain('went down')
    // Cat looked at both rooms: no substitute
    await t.send(amy, { type: 'matchPause', matchId: id, paused: true })
    const replace = { type: 'matchReplace', matchId: id, room: 'closed', seat: 'S' } as const
    expect(await t.refused(amy, { ...replace, userId: dan } as ClientMessage)).toBe('matchWatching')
    const eve = await t.member('eve')
    expect(await t.refused(amy, { ...replace, userId: eve } as ClientMessage)).toBeUndefined()
    // Ben, substituted out, still may not look: the tables remember him
    await expect(vugraph(people.ben, id)).rejects.toMatchObject({ code: 'matchNoWatching' })
  })
})

describe('watching one trick behind (e8-t19)', () => {
  it('is the host’s setting, off unless turned on, and only a yes or a no', async () => {
    const m = await t.match({ boards: 4 })
    expect(t.club().matches.get(m.id, m.amy)!.settings.delay).toBe(false)
    expect(() => t.club().matches.update(m.amy, m.id, { delay: 'yes' })).toThrow(expect.objectContaining({ code: 'badMatchSettings', params: { field: 'delay' } }))
    expect(t.club().matches.update(m.amy, m.id, { delay: true }).settings.delay).toBe(true)
  })

  it('shows the watchers only the tricks before the last finished one, on the Vugraph page and at the table', async () => {
    const { id, amy, open } = await started({ delay: true })
    const cat = await t.member('cat')
    await t.send(cat, { type: 'joinTable', tableId: open })
    await t.playUntil([amy], () => played(open) >= 9)
    const n = played(open)
    const shown = 4 * (Math.floor(n / 4) - 1)
    const board = t.tableState(open)!.board!
    const page = await vugraph(cat, id)
    expect(cardsShown(page.rooms.open!.board)).toBe(shown)
    expect(cardsShown(t.view(cat)!.board)).toBe(shown)
    expect(t.view(cat)!.waiting).toBeNull()
    // A card played since is still in its hand, as it was then
    const later = board.play[shown]
    expect(page.rooms.open!.board!.hands[later.seat]).toContain(later.card)
    // The cards played since never reached the watcher's browser
    const since = board.play.slice(shown).map((p) => p.card)
    const wire = JSON.stringify(page.rooms.open!.board!.tricks) + JSON.stringify(t.view(cat)!.board!.tricks)
    for (const card of since) expect(wire).not.toContain(`"${card}"`)
    // The player sees the play as it is
    expect(cardsShown(t.view(amy)!.board)).toBe(n)
    // A finished board is shown whole
    await t.playUntil([amy], () => t.tableState(open)!.board!.phase === 'finished')
    const done = (await vugraph(cat, id)).rooms.open!.board!
    expect(cardsShown(done)).toBe(t.tableState(open)!.board!.play.length)
    expect(done.result).toBeDefined()
  })

  it('shows everything as it is when the match does not lag', async () => {
    const { id, amy, open } = await started()
    const cat = await t.member('cat')
    await t.playUntil([amy], () => played(open) >= 9)
    expect(cardsShown((await vugraph(cat, id)).rooms.open!.board)).toBe(played(open))
  })
})
