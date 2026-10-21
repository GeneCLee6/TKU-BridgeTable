/**
 * The little key-value API the club needs. The Durable Object backs it with its own storage;
 * tests use MemoryStore.
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

export interface Store {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list<T>(prefix: string, options?: ListOptions): Promise<Map<string, T>>
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
