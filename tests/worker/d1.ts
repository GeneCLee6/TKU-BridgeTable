/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite'
import type { ReplicaDb } from '../../worker/history-replica.ts'
import type { Statement } from '../../worker/history-index.ts'
import type { SqlValue } from '../../worker/store.ts'

/**
 * A stand-in for D1 (ARCHITECTURE.md §5.12): SQLite in memory behind the `ReplicaDb` interface,
 * each batch in one transaction as D1 runs it. `fail` makes the next batches throw (D1 down, or its
 * daily limit reached); `batches` and `statements` count the round trips and queries
 */
export interface MemoryD1 extends ReplicaDb {
  readonly db: DatabaseSync
  fail: Error | null
  batches: number
  statements: number
  /** The most statements one batch had (the free plan allows 50 queries per call) */
  largest: number
  rows<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): T[]
}

export function memoryD1(): MemoryD1 {
  const db = new DatabaseSync(':memory:')
  const d1: MemoryD1 = {
    db,
    fail: null,
    batches: 0,
    statements: 0,
    largest: 0,
    async batch(statements: Statement[]) {
      await Promise.resolve()
      if (d1.fail) throw d1.fail
      d1.batches++
      d1.statements += statements.length
      d1.largest = Math.max(d1.largest, statements.length)
      for (const s of statements) if (s.params.length > 100) throw new Error(`too many SQL variables: ${s.params.length}`)
      db.exec('BEGIN')
      try {
        const results = statements.map(({ sql, params }) => {
          const statement = db.prepare(sql)
          return (statement.columns().length ? statement.all(...params) : (statement.run(...params), [])) as Record<string, SqlValue>[]
        })
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    rows: <T>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
  }
  return d1
}
