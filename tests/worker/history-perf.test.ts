// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_HISTORY_QUERY, type HistoryQuery } from '../../shared/history-query.ts'
import { summarize, type BoardRecord } from '../../shared/protocol.ts'
import { createHistoryIndex, indexRecord, searchBoards } from '../../worker/history-index.ts'
import { BOARDS, fixtures, HOUR, START } from './history-fixtures.ts'
import { memoryStore } from './sqlite.ts'

/**
 * AC-4.8 (e4-t23): with 10,000 boards in the index, the first page of every kind of search —
 * one condition, several, the heaviest player/partner joins, every sort — comes back in under
 * 300 ms on the server: the SQL count and page plus reading that page's records, as
 * `ClubService.search` does. The timings are printed so they can go in the PR.
 */

const LIMIT_MS = 300

const SEARCHES: [string, Partial<HistoryQuery>][] = [
  ['all, newest first', {}],
  ['mine', { scope: 'mine' }],
  ['4♠', { level: 4, strain: 'S' }],
  ['doubled', { doubled: 'doubled' }],
  ['redoubled', { doubled: 'XX' }],
  ['game', { bracket: 'game' }],
  ['slam', { bracket: 'slam' }],
  ['passed out', { bracket: 'passout' }],
  ['declarer m3', { declarer: 'm3' }],
  ['declarer seat E', { declarerSeat: 'E' }],
  ['I declared', { declarerSide: 'me' }],
  ['partner declared', { declarerSide: 'partner' }],
  ['opponents declared', { declarerSide: 'opponents' }],
  ['player m7', { player: 'm7' }],
  ['mine with m7', { scope: 'mine', player: 'm7' }],
  ['partner m2', { partner: 'm2' }],
  ['one month', { from: '2025-06-01', to: '2025-06-30' }],
  ['made', { result: 'made' }],
  ['down', { result: 'down' }],
  ['vul both', { vul: 'Both' }],
  ['board 7', { boardNo: 7 }],
  ['table 3', { table: 3 }],
  ['challenge', { mode: 'challenge' }],
  ['score high', { sort: 'score_desc' }],
  ['tricks low', { sort: 'tricks_asc' }],
  ['date oldest', { sort: 'date_asc' }],
  ['page 50 of all', { page: 50 }],
  ['mine, 100 a page', { scope: 'mine', size: 100 }],
  ['everything at once', { scope: 'mine', strain: 'S', doubled: 'undoubled', declarerSide: 'opponents', partner: 'm2', result: 'down', from: '2025-02-01', sort: 'score_asc' }],
  ['partner + player + sort', { partner: 'm2', player: 'm9', sort: 'tricks_desc' }],
  ['no match', { level: 7, strain: 'N', doubled: 'XX', vul: 'None', boardNo: 1 }],
]

describe('history search performance (AC-4.8)', () => {
  it(`returns the first page of every search over ${BOARDS} boards in under ${LIMIT_MS} ms`, { timeout: 120_000 }, async () => {
    const store = memoryStore()
    createHistoryIndex(store.sql)
    const records = fixtures()
    store.sql.transaction(() => {
      for (const record of records) indexRecord(store.sql, record)
    })
    for (const record of records) await store.put(`board:${record.id}`, record)
    const now = START + BOARDS * HOUR
    const viewer = 'm7'

    const page = async (query: Partial<HistoryQuery>) => {
      const found = searchBoards(store.sql, { ...DEFAULT_HISTORY_QUERY, scope: 'all', ...query }, viewer, now)
      const loaded = await Promise.all(found.ids.map((id) => store.get<BoardRecord>(`board:${id}`)))
      return { ...found, boards: loaded.flatMap((r) => (r ? [summarize(r)] : [])) }
    }
    // Warm up the prepared statements and page cache, as a running Durable Object has them
    await page({})

    const timings: [string, number, number][] = []
    for (const [name, query] of SEARCHES) {
      // The slowest of three runs, so one lucky run does not hide a slow search
      let worst = 0
      let total = 0
      for (let run = 0; run < 3; run++) {
        const started = performance.now()
        const result = await page(query)
        worst = Math.max(worst, performance.now() - started)
        total = result.total
        // Kept-back boards stay hidden from everyone who did not play them
        for (const board of result.boards) if (board.revealAt && board.revealAt > now) expect(Object.values(board.players).some((p) => p.id === viewer)).toBe(true)
      }
      timings.push([name, worst, total])
    }

    console.log(
      [`history search over ${BOARDS} boards (slowest of 3, ms):`, ...timings.map(([name, ms, n]) => `  ${ms.toFixed(1).padStart(7)}  ${name} (${n} boards)`)].join('\n'),
    )
    for (const [name, ms] of timings) expect(ms, name).toBeLessThan(LIMIT_MS)
    // The searches really searched: the combined filters narrow the list and some match nothing
    expect(timings[0][2]).toBeGreaterThan(9_000)
    expect(timings.at(-1)![2]).toBeLessThan(timings[0][2])
  })
})
