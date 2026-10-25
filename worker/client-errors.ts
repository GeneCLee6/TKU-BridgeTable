import { scrub } from '../shared/scrub.ts'
import type { LogEntry } from './log.ts'

/** The largest error report the server reads (characters) */
export const CLIENT_ERROR_MAX_CHARS = 8192

const MESSAGE_MAX = 500
const STACK_MAX = 2000
const FIELD_MAX = 200

const field = (value: unknown, max: number) => (typeof value === 'string' && value ? scrub(value, max) : undefined)

/** Reads an error report from `/api/client-errors`; null when it is not one */
export function parseClientError(raw: string): Extract<LogEntry, { event: 'clientError' }> | null {
  if (raw.length > CLIENT_ERROR_MAX_CHARS) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const body = data as Record<string, unknown>
  const message = field(body.message, MESSAGE_MAX)
  if (!message) return null
  const entry: Extract<LogEntry, { event: 'clientError' }> = {
    event: 'clientError',
    kind: body.kind === 'rejection' ? 'rejection' : 'error',
    message,
  }
  const source = field(body.source, FIELD_MAX)
  const stack = field(body.stack, STACK_MAX)
  const page = field(body.page, FIELD_MAX)
  const version = field(body.version, 40)
  if (source) entry.source = source
  if (stack) entry.stack = stack
  if (page) entry.page = page
  if (version) entry.version = version
  return entry
}
