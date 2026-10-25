// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_HISTORY_QUERY, type HistoryQuery } from '../../shared/history-query.ts'
import { summarize, type BoardRecord } from '../../shared/protocol.ts'
import { mintPass, readPass } from '../../worker/edge-auth.ts'
import { createHistoryIndex, indexRecord, searchBoards } from '../../worker/history-index.ts'
import { REPLICA_BATCH, REPLICA_SCHEMA, replicaWrites, searchReplica } from '../../worker/history-replica.ts'
import { memoryD1 } from './d1.ts'
import { BOARDS, fixtures, HOUR, START } from './history-fixtures.ts'
import { memoryStore } from './sqlite.ts'

/**
 * What H2a buys (ARCHITECTURE.md §5.12), measured over the same 10,000 boards as AC-4.8: the CPU a
 * history page costs the club's Durable Object before (its SQL, reading the page's records, the
 * summaries), against what the Worker itself spends answering it from D1 (checking the pass and
 * turning the rows into the answer; the SQL runs in D1, not on the Worker's CPU); and how many
 * statements copying boards to D1 takes. Printed so the numbers can go in the PR; the checks are loose
 */

const SECRET = 'cost-test-secret-0123456789'
const RUNS = 5

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

describe('what answering history at the edge saves the club', () => {
  it('measures the club’s CPU per history page against the Worker’s own', { timeout: 120_000 }, async () => {
    const store = memoryStore()
    createHistoryIndex(store.sql)
    const records = fixtures()
    store.sql.transaction(() => {
      for (const record of records) indexRecord(store.sql, record)
    })
    for (const record of records) await store.put(`board:${record.id}`, record)
    const d1 = memoryD1()
    await d1.batch([...REPLICA_SCHEMA.map((sql) => ({ sql, params: [] })), { sql: "INSERT INTO index_meta VALUES ('ready', '1')", params: [] }])
    for (let i = 0; i < records.length; i += REPLICA_BATCH) await d1.batch(replicaWrites(records.slice(i, i + REPLICA_BATCH), []))
    const now = START + BOARDS * HOUR
    const viewer = 'm7'

    const clubPage = async (query: HistoryQuery) => {
      const found = searchBoards(store.sql, query, viewer, now)
      const loaded = await Promise.all(found.ids.map((id) => store.get<BoardRecord>(`board:${id}`)))
      return JSON.stringify({ boards: loaded.flatMap((r) => (r ? [summarize(r)] : [])), total: found.total })
    }
    // The Worker's own part: the pass, then the rows D1 sent back (summaries as text) into the answer
    const pass = await mintPass(SECRET, viewer, now)
    const workerPart = async (rows: Record<string, unknown>[]) => {
      await readPass(SECRET, pass, now)
      return JSON.stringify({ boards: rows.map((row) => JSON.parse(String(row.summary))) })
    }

    const lines: string[] = []
    const queries: [string, Partial<HistoryQuery>][] = [
      ['all, newest first, 20', { scope: 'all' }],
      ['mine, 20', {}],
      ['partner m2, 20', { scope: 'all', partner: 'm2' }],
      ['all, 100 a page', { scope: 'all', size: 100 }],
    ]
    for (const [name, q] of queries) {
      const query = { ...DEFAULT_HISTORY_QUERY, ...q }
      const page = (await searchReplica(d1, query, viewer, now))!
      expect(JSON.parse(await clubPage(query)).total).toBe(page.total)
      const rows = page.boards.map((b) => ({ summary: JSON.stringify(b) }))
      const club: number[] = []
      const worker: number[] = []
      for (let run = 0; run < RUNS; run++) {
        let started = performance.now()
        await clubPage(query)
        club.push(performance.now() - started)
        started = performance.now()
        await workerPart(rows)
        worker.push(performance.now() - started)
      }
      lines.push(`  ${name.padEnd(24)} club ${median(club).toFixed(2).padStart(6)} ms   worker ${median(worker).toFixed(2).padStart(5)} ms`)
      // Loose on purpose: the whole suite runs side by side in CI, and the printed numbers are the point
      expect(median(worker)).toBeLessThan(100)
    }

    // Copying to D1: statements per batch of REPLICA_BATCH boards, and batches to fill 10,000
    const statements = replicaWrites(records.slice(0, REPLICA_BATCH), []).length
    lines.push(
      `  copying: ${statements} statements per ${REPLICA_BATCH} boards (free plan: 50 per call); filling ${BOARDS} boards takes ${Math.ceil(BOARDS / REPLICA_BATCH)} steps`,
    )
    console.log([`history page over ${BOARDS} boards (median of ${RUNS}):`, ...lines].join('\n'))
    expect(statements).toBeLessThanOrEqual(15)
  })
})
