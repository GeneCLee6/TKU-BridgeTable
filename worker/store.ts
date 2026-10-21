/**
 * The little key-value API the club needs. The Durable Object backs it with its own storage;
 * tests use MemoryStore.
 *
 * Keys: `user:<id>`, `session:<token>`, `table:<id>`, `board:<time>-<id>` (history, sortable).
 */
export interface Store {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list<T>(prefix: string): Promise<Map<string, T>>
}

export class MemoryStore implements Store {
  readonly data = new Map<string, unknown>()

  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value))
  }
  async delete(key: string) {
    this.data.delete(key)
  }
  async list<T>(prefix: string) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort()
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k)) as T]))
  }
}
