/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type Sql, type SqlValue } from '../../worker/store.ts'

/** An in-memory SQLite database that behaves like the Durable Object's `ctx.storage.sql` */
export function memorySql(): Sql {
  const db = new DatabaseSync(':memory:')
  let depth = 0
  return {
    exec: <T>(query: string, ...params: SqlValue[]) => {
      const statement = db.prepare(query)
      return (statement.columns().length ? statement.all(...params) : (statement.run(...params), [])) as T[]
    },
    transaction: (fn) => {
      // Nested calls join the outer transaction, as transactionSync does
      if (depth > 0) return fn()
      depth++
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        depth--
      }
    },
  }
}

export const memoryStore = () => new MemoryStore(memorySql())
