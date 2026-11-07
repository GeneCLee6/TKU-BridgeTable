// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { teamHarness, tick } from './team-match-harness.ts'

/**
 * A practice table whose conditions give no next board (AC-10.1): it says so to everyone at it and
 * the member has a way on, instead of standing still in silence. The dealer is told when to give up,
 * so that "could not be met this time" does not depend on chance
 */

const dealer = vi.hoisted(() => ({ deals: Infinity }))
vi.mock('../../shared/dealer.ts', async (original) => {
  const actual = await original<typeof import('../../shared/dealer.ts')>()
  return {
    ...actual,
    dealWith: (...args: Parameters<typeof actual.dealWith>) => {
      if (dealer.deals <= 0) return { ok: false, attempts: 5000 }
      dealer.deals--
      return actual.dealWith(...args)
    },
  }
})

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  dealer.deals = Infinity
  t = await teamHarness()
})

/** The countdown runs out and the table's next board is due */
async function dealDue() {
  const due = t.h.queue.filter((job) => job.kind === 'deal')
  expect(due.length).toBeGreaterThan(0)
  t.h.time += Math.max(0, ...due.map((job) => job.ms))
  await t.run('deal')
  for (let i = 0; i < 5; i++) await tick()
}

describe('a practice table with no next board (AC-10.1)', () => {
  it('tells the member and anyone watching when the next board does not come by itself, and redeal gets it going again', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    await t.send(amy, { type: 'createPractice', settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false }, access: 'public' })
    const table = t.club().lobbyView(amy).myTableId!
    await t.send(ben, { type: 'joinTable', tableId: table })
    expect(t.view(amy)!.practice?.dealStuck).toBeUndefined()

    await t.playUntil([amy], () => t.played(table) >= 1)
    const finished = t.view(amy)!.board!
    expect(finished.phase).toBe('finished')
    expect(t.view(amy)!.dealAt).not.toBeNull()
    const dealt = t.view(amy)!.practice!.dealt

    dealer.deals = 0
    await dealDue()
    // The last board stays, nothing counts down, and both of them are told why
    for (const userId of [amy, ben]) {
      const view = t.view(userId)!
      expect(view.board?.boardNo).toBe(finished.boardNo)
      expect(view.dealAt).toBeNull()
      expect(view.practice?.dealStuck).toBe(true)
    }
    expect(t.view(amy)!.practice!.dealt).toBe(dealt)
    // Kept with the table, so a table object woken up later still knows
    expect(t.tableState(table)!.modeState).toMatchObject({ dealStuck: true })

    // Trying again may fail again: refused, and still said on the table
    expect(await t.refused(amy, { type: 'redeal' })).toBe('dealTooStrict')
    expect(t.view(amy)!.practice?.dealStuck).toBe(true)
    // Only the member deals
    expect(await t.refused(ben, { type: 'redeal' })).toBe('hostOnly')

    dealer.deals = Infinity
    expect(await t.refused(amy, { type: 'redeal' })).toBeUndefined()
    for (const userId of [amy, ben]) {
      expect(t.view(userId)!.board?.phase).toBe('auction')
      expect(t.view(userId)!.board?.boardNo).not.toBe(finished.boardNo)
      expect(t.view(userId)!.practice?.dealStuck).toBeUndefined()
    }
  })

  it('leaves a board being played alone when a redeal fails: it goes on, with nothing to report on the table', async () => {
    const amy = await t.member('amy')
    await t.send(amy, { type: 'createPractice', settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false } })
    const board = t.view(amy)!.board!
    dealer.deals = 0
    expect(await t.refused(amy, { type: 'redeal' })).toBe('dealTooStrict')
    expect(t.view(amy)!.board?.hands.S).toEqual(board.hands.S)
    expect(t.view(amy)!.board?.phase).toBe('auction')
    expect(t.view(amy)!.practice?.dealStuck).toBeUndefined()
  })

  it('says so when even the first board does not come, though the check before opening passed', async () => {
    const amy = await t.member('amy')
    // The check before opening the table draws once; its first board does not come
    dealer.deals = 1
    await t.send(amy, { type: 'createPractice', settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false } })
    expect(t.view(amy)!.board).toBeNull()
    expect(t.view(amy)!.practice?.dealStuck).toBe(true)
    dealer.deals = Infinity
    await t.send(amy, { type: 'redeal' })
    expect(t.view(amy)!.board?.phase).toBe('auction')
    expect(t.view(amy)!.practice?.dealStuck).toBeUndefined()
  })

  it('at a bidding practice says so when 下一副 fails, and bidding the same board again clears it', async () => {
    const amy = await t.member('amy')
    await t.send(amy, { type: 'createPractice', settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false, biddingOnly: true } })
    await t.playUntil([amy], () => t.view(amy)!.board?.phase === 'finished')
    const hands = t.view(amy)!.board!.hands.S
    dealer.deals = 0
    expect(await t.refused(amy, { type: 'redeal' })).toBe('dealTooStrict')
    expect(t.view(amy)!.practice?.dealStuck).toBe(true)
    await t.send(amy, { type: 'rebid' })
    expect(t.view(amy)!.board?.phase).toBe('auction')
    expect(t.view(amy)!.board?.hands.S).toEqual(hands)
    expect(t.view(amy)!.practice?.dealStuck).toBeUndefined()
  })

  it('never reports it at a table dealing any hands, which cannot fail', async () => {
    const amy = await t.member('amy')
    dealer.deals = 0
    await t.send(amy, { type: 'createPractice', settings: { deal: 'random', robotKind: 'gib', justDeclare: false } })
    const table = t.club().lobbyView(amy).myTableId!
    await t.playUntil([amy], () => t.played(table) >= 1)
    await dealDue()
    expect(t.view(amy)!.board?.phase).not.toBe('finished')
    expect(t.view(amy)!.practice?.dealStuck).toBeUndefined()
  })
})
