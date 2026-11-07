/**
 * Structured logs: one JSON line per event, which Workers Logs (wrangler.jsonc `observability`)
 * indexes by field. Never put passwords, tokens, cookies or chat text in a log entry
 */
export type LogEntry = LogEvent & {
  /** The club whose object wrote the line (`clubLog`, e12-t03) */
  club?: string
}

type LogEvent =
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
  /** Email (e1-t29, e1-t30): an address verified, a password reset by its link, or a mail the provider refused; never who or which address */
  | { event: 'emailVerified' }
  /** Google sign-in and LINE login (e1-t31, e1-t32): never the account, the address or the name; `reason` says which check failed */
  | { event: 'oauthSignIn' | 'oauthLinked' | 'oauthUnlinked'; provider: 'google' | 'line' }
  | { event: 'oauthFailed'; provider: 'google' | 'line'; reason: string }
  /**
   * Web Push (e1-t28): one batch sent; how many went out, failed (the push service's status, or no
   * answer) and how many dead subscriptions (404/410) were removed. Never who or which device
   */
  | { event: 'push'; sent: number; failed: number; removed: number; statuses?: string }
  | { event: 'passwordResetByEmail' }
  | { event: 'mailFailed'; kind: 'verify' | 'reset' | 'security' }
  /**
   * 兩步驟登入 (e11-t31): turned on, off (by the member or another admin), a wrong code at sign-in, a
   * recovery code used, or cleared by the site's owner with TWO_FACTOR_RESET_TOKEN (DEPLOY.md §4.15); never who
   */
  | { event: 'twoFactorOn' | 'twoFactorOff' | 'twoFactorCleared' | 'twoFactorFailed' | 'twoFactorRecoveryUsed' | 'twoFactorOwnerReset' }
  /** A sign-in came with an address but SEEN_SALT is not set: the anti-cheating report keeps no network (§5.17) */
  | { event: 'seenSaltMissing' }
  /** An address used up its registrations for the hour (e1-t33); the address is not logged */
  | { event: 'registerLimited' }
  /** Turnstile turned a registration away (e1-t33): Cloudflare's error codes, or `unreachable` */
  | { event: 'turnstileFailed'; codes: string }
  /** Tables moved between the club and their own objects (schema 3 ↔ 4, ARCHITECTURE.md §5.10) */
  | { event: 'tablesMoved'; to: 'objects' | 'club'; moved: number; failed: number }
  /** Challenges (H2b) or team matches (`kind: 'matches'`, H2c) moved between the club and their own objects (§5.12) */
  | { event: 'eventsMoved'; kind?: 'matches'; to: 'objects' | 'club'; moved: number; failed: number }
  /** An error a browser reported (`/api/client-errors`), already cleaned */
  | { event: 'clientError'; kind: string; message: string; source?: string; stack?: string; page?: string; version?: string; site?: 'book' }
  /** A bug: an exception that is not a ClubError or GameError */
  | { event: 'crash'; where: string; error: string; stack?: string }
  /** The history index's D1 copy (worker/history-replica.ts, §5.12): a step that failed, or the copy filled */
  | { event: 'replica'; step: 'fill' | 'flush' | 'off'; ok: boolean; error?: string }
  /** A history page the Worker answered from D1 (§5.12), or why it handed the request to the club */
  | { event: 'edge'; path: string; status?: number; ms: number; fallback?: 'notReady' | 'error' | 'revoked' }
  /**
   * The platform (e12-t05, e12-t06; worker/platform.ts): an application kept (its wanted club id, never
   * who), an address over its applications for the hour, a club's object that did not answer for its
   * usage, a mail to an applicant the provider refused, a club suspended or served again
   */
  | { event: 'clubApplied'; clubId: string }
  | { event: 'clubApplyLimited' }
  | { event: 'platformUsage'; clubId: string; error: string }
  | { event: 'clubApplyMail'; ok: boolean; error: string }
  | { event: 'clubApplyNotify'; ok: boolean; error: string }
  | { event: 'clubStatus'; status: 'active' | 'suspended' | 'provisioned' }
  /** The daily backup to R2 (worker/backup.ts): what it wrote, or why it failed; `step` is a later step's (worker/backup-steps.ts) */
  | {
      event: 'backup'
      ok: boolean
      step?: 'step' | 'activity' | 'sweep' | 'restore'
      name?: string
      keys?: number
      rows?: number
      bytes?: number
      deleted?: number
      parts?: number
      objects?: number
      boards?: number
      error?: string
    }

export type Logger = (entry: LogEntry) => void

export const noLog: Logger = () => {}

/**
 * Every line of a club's objects (its own, its tables' and events') says which club (e12-t03), so
 * Workers Logs can be filtered by club. 淡江's lines say `tku`
 */
export function clubLog(clubId: string, log: Logger): Logger {
  return (entry) => log({ ...entry, club: clubId })
}

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
