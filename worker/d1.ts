import type { ReplicaDb } from './history-replica.ts'
import type { SqlValue } from './store.ts'

/**
 * A D1 binding as the history copy uses it (`ReplicaDb`, ARCHITECTURE.md §5.12): statements go in one
 * `batch`, which D1 runs in one round trip and one transaction. The only code that touches D1
 */
export function d1Replica(db: D1Database): ReplicaDb {
  return {
    async batch(statements) {
      if (!statements.length) return []
      const results = await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)))
      return results.map((result) => (result.results ?? []) as Record<string, SqlValue>[])
    },
  }
}
