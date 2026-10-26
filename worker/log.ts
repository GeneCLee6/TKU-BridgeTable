/**
 * Structured logs: one JSON line per event, which Workers Logs (wrangler.jsonc `observability`)
 * indexes by field. Never put passwords, tokens, cookies or chat text in a log entry
 */
export type LogEntry =
  /** A WebSocket message from a member: its type, how long it took, and the error code if it failed */
  | { event: 'action'; type: string; user: string; ms: number; code?: string }
  /** A message that never reached a handler: too large, not valid, or over the rate limit */
  | { event: 'rejected'; user: string; code: string; type?: string }
  | { event: 'http'; method: string; path: string; status: number; ms: number; code?: string }
  | { event: 'loginLocked'; username: string }
  /** Tables moved between the club and their own objects (schema 3 ↔ 4, ARCHITECTURE.md §5.10) */
  | { event: 'tablesMoved'; to: 'objects' | 'club'; moved: number; failed: number }
  | { event: 'eventsMoved'; to: 'objects' | 'club'; moved: number; failed: number }
  /** An error a browser reported (`/api/client-errors`), already cleaned */
  | { event: 'clientError'; kind: string; message: string; source?: string; stack?: string; page?: string; version?: string }
  /** A bug: an exception that is not a ClubError or GameError */
  | { event: 'crash'; where: string; error: string; stack?: string }
  /** The history index's D1 copy (worker/history-replica.ts, §5.12): a step that failed, or the copy filled */
  | { event: 'replica'; step: 'fill' | 'flush' | 'off'; ok: boolean; error?: string }
  /** A history page the Worker answered from D1 (§5.12), or why it handed the request to the club */
  | { event: 'edge'; path: string; status?: number; ms: number; fallback?: 'notReady' | 'error' }
  /** The daily backup to R2 (worker/backup.ts): what it wrote, or why it failed */
  | { event: 'backup'; ok: boolean; name?: string; keys?: number; bytes?: number; deleted?: number; error?: string }

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
