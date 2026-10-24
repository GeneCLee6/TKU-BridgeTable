/**
 * The little key-value API the club needs, plus the object's SQLite database for the history
 * index (`worker/history-index.ts`). The Durable Object backs both with its own storage; tests use
 * MemoryStore with an in-memory SQLite database (`tests/worker/sqlite.ts`).
 *
 * Keys are listed in ARCHITECTURE.md §5. `list` returns keys in order; `start` is inclusive and
 * `end` exclusive, as in Durable Object storage.
 */
export interface ListOptions {
  reverse?: boolean
  limit?: number
  start?: string
  end?: string
}

export type SqlValue = string | number | null

/** SQL as the Durable Object runs it: synchronous, one statement per call, bound `?` parameters */
export interface Sql {
  exec<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[]
  /** Runs `fn` in one transaction: if it throws, nothing it wrote is kept */
  transaction<T>(fn: () => T): T
}

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list<T>(prefix: string, options?: ListOptions): Promise<Map<string, T>>
  readonly sql: Sql
}

/** For stores that never need SQL (the book's tests) */
const NO_SQL: Sql = {
  exec: () => {
    throw new Error('This store has no SQL database')
  },
  transaction: (fn) => fn(),
}

export class MemoryStore implements Store {
  readonly data = new Map<string, unknown>()
  readonly sql: Sql

  constructor(sql: Sql = NO_SQL) {
    this.sql = sql
  }

  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value))
  }
  async delete(key: string) {
    this.data.delete(key)
  }
  async list<T>(prefix: string, options: ListOptions = {}) {
    let keys = [...this.data.keys()]
      .filter((k) => k.startsWith(prefix))
      .filter((k) => (options.start === undefined || k >= options.start) && (options.end === undefined || k < options.end))
      .sort()
    if (options.reverse) keys.reverse()
    if (options.limit !== undefined) keys = keys.slice(0, options.limit)
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]))
  }
}
