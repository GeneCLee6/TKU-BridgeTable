import { appendFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * Append-only JSON Lines files for the results (eval/sim/README.md): one record a line, each with
 * its board number. A run that stops (or is stopped) keeps everything written so far; the next run
 * on the same file reads the board numbers already there and does only the rest. Reading streams
 * the file line by line, so a million records need no more memory than one.
 */
export class JsonlStore<T extends { board: number }> {
  readonly path: string
  /** Boards already in the file */
  readonly done = new Set<number>()

  private constructor(path: string) {
    this.path = path
  }

  static async open<T extends { board: number }>(path: string): Promise<JsonlStore<T>> {
    const store = new JsonlStore<T>(path)
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      for await (const line of store.lines()) {
        const match = /"board":(\d+)/.exec(line)
        if (match) store.done.add(Number(match[1]))
      }
    }
    return store
  }

  append(records: readonly T[]) {
    if (!records.length) return
    appendFileSync(this.path, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    for (const r of records) this.done.add(r.board)
  }

  private async *lines(): AsyncGenerator<string> {
    const input = createReadStream(this.path, { encoding: 'utf8' })
    for await (const line of createInterface({ input, crlfDelay: Infinity })) if (line.trim()) yield line
  }

  /** Every record in the file, in order */
  async *records(): AsyncGenerator<T> {
    if (!existsSync(this.path)) return
    for await (const line of this.lines()) yield JSON.parse(line) as T
  }
}
