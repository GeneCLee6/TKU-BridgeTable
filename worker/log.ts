/**
 * Structured logs: one JSON line per event, which Workers Logs (wrangler.jsonc `observability`)
 * indexes by field. Never put passwords, tokens, cookies or chat text in a log entry
 */
export type LogEntry =
  /** A WebSocket message from a member: its type, how long it took, and the error code if it failed */
  | {
      event: 'action'
      type: string
      user: string
      ms: number
      code?: string
      /** Logged as one of this many like it (`sampleActions`): count it that many times */
      sample?: number
    }
  /** A message that never reached a handler: too large, not valid, or over the rate limit */
  | { event: 'rejected'; user: string; code: string; type?: string }
  | { event: 'http'; method: string; path: string; status: number; ms: number; code?: string }
  | { event: 'loginLocked'; username: string }
  /** A member deleted their own account (e11-t27); only that it happened, not who */
  | { event: 'accountDeleted' }
  /** Tables moved between the club and their own objects (schema 3 ↔ 4, ARCHITECTURE.md §5.10) */
  | { event: 'tablesMoved'; to: 'objects' | 'club'; moved: number; failed: number }
  | { event: 'eventsMoved'; to: 'objects' | 'club'; moved: number; failed: number }
  /** An error a browser reported (`/api/client-errors`), already cleaned */
  | { event: 'clientError'; kind: string; message: string; source?: string; stack?: string; page?: string; version?: string; site?: 'book' }
  /** A bug: an exception that is not a ClubError or GameError */
  | { event: 'crash'; where: string; error: string; stack?: string }
  /** The history index's D1 copy (worker/history-replica.ts, §5.12): a step that failed, or the copy filled */
  | { event: 'replica'; step: 'fill' | 'flush' | 'off'; ok: boolean; error?: string }
  /** A history page the Worker answered from D1 (§5.12), or why it handed the request to the club */
  | { event: 'edge'; path: string; status?: number; ms: number; fallback?: 'notReady' | 'error' | 'revoked' }
  /** The daily backup to R2 (worker/backup.ts): what it wrote, or why it failed */
  | { event: 'backup'; ok: boolean; name?: string; keys?: number; rows?: number; bytes?: number; deleted?: number; error?: string }

export type Logger = (entry: LogEntry) => void

export const noLog: Logger = () => {}

/** The Durable Object's logger: errors go to console.error so they show as errors in Workers Logs */
export const jsonLog: Logger = (entry) => {
  const line = JSON.stringify({ level: entry.event === 'crash' || entry.event === 'clientError' ? 'error' : 'info', ...entry })
  if (entry.event === 'crash' || entry.event === 'clientError') console.error(line)
  else console.log(line)
}

export function crashEntry(where: string, error: unknown): LogEntry {
  return error instanceof Error
    ? { event: 'crash', where, error: error.message, stack: error.stack?.slice(0, 2000) }
    : { event: 'crash', where, error: String(error) }
}

/**
 * One in this many quick actions that worked is written to Workers Logs (H3b, docs/LOAD.md §5): at
 * 200 members a line for every action is about 900 lines a minute, near the free plan's 200,000 a day
 */
export const ACTION_SAMPLE = 10
/** An action at least this slow (ms) is always written */
export const ACTION_SLOW_MS = 200

/**
 * Writes every entry but the `action` ones, of which one in `sample` (marked `sample`); an action
 * that failed or was slow always. The status page counts every entry before this (`worker/metrics.ts`)
 */
export function sampleActions(write: Logger, sample = ACTION_SAMPLE, random: () => number = Math.random): Logger {
  return (entry) => {
    if (entry.event !== 'action' || entry.code || entry.ms >= ACTION_SLOW_MS) return write(entry)
    if (random() * sample < 1) write({ ...entry, sample })
  }
}
