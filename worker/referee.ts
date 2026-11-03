import { REFEREE_LIMITS, type RefereeAction, type RefereeEntry, type RefereeEvent } from '../shared/referee.ts'
import type { BoardRecord } from '../shared/protocol.ts'
import type { AuditAction, AuditLog } from './audit.ts'
import type { Store } from './store.ts'

/**
 * The director's log of each club event (`e9-t17`, ARCHITECTURE.md §5.23): `referee:<kind>:<id>`,
 * one small list per event, kept in memory (the pages are built synchronously and read the
 * penalties every time). Every entry also goes into the audit log (`audit:`), the same one as
 * TKU BridgeHall's changes, so an admin sees who did what when in one place. No Cloudflare API.
 */

const KEY = 'referee:'

const AUDIT: Record<RefereeAction['action'], AuditAction> = {
  score: 'referee:score',
  penalty: 'referee:penalty',
  withdraw: 'referee:withdraw',
  delay: 'referee:delay',
  restart: 'referee:restart',
}

/** The event a board record belongs to, as the director's log names it */
export function refereeKindOf(record: Pick<BoardRecord, 'mode' | 'eventId'>): RefereeEvent | null {
  if (!record.eventId) return null
  if (record.mode === 'pairs') return 'pairs'
  if (record.mode === 'team') return 'match'
  if (record.mode === 'challenge') return 'challenge'
  return null
}

/** What an entry did, in a few words for the audit log (the reason follows it) */
export function describe(action: RefereeAction): string {
  switch (action.action) {
    case 'score': {
      const where = action.boardId ? `board:${action.boardId}` : `round ${action.round} table ${action.table} board ${action.boardNo}`
      const r = action.ruling
      const what = !r ? 'ruling removed' : r.kind === 'score' ? `score ${r.scoreNS}` : `${r.kind}${r.side ? ` ${r.side}` : ''}`
      return `${where}: ${what}`
    }
    case 'penalty':
      return `${action.target}: -${action.amount}`
    case 'withdraw':
      return `penalty ${action.of} withdrawn`
    case 'delay':
      return action.until === null ? 'delay lifted' : `start at ${new Date(action.until).toISOString()}`
    case 'restart':
      return `round ${action.round} table ${action.table}${action.replay.length ? ` replay ${action.replay.join(',')}` : ''}`
  }
}

export class RefereeLog {
  private readonly store: Store
  private readonly audit: AuditLog
  private readonly now: () => number
  private readonly newId: () => string
  private readonly logs = new Map<string, RefereeEntry[]>()

  constructor(store: Store, audit: AuditLog, now: () => number, newId: () => string) {
    this.store = store
    this.audit = audit
    this.now = now
    this.newId = newId
  }

  async load() {
    for (const [key, entries] of await this.store.list<RefereeEntry[]>(KEY)) this.logs.set(key.slice(KEY.length), entries)
  }

  /** An event's entries, oldest first */
  of(kind: RefereeEvent, eventId: string): readonly RefereeEntry[] {
    return this.logs.get(`${kind}:${eventId}`) ?? []
  }

  /**
   * Adds an entry and writes it to the audit log; `auditTarget` is what the audit log names (the
   * event, or the board record a ruling was on)
   */
  async add(
    kind: RefereeEvent,
    eventId: string,
    actor: { id: string; username: string },
    action: RefereeAction,
    reason: string,
    auditTarget = `${kind}:${eventId}`,
  ): Promise<RefereeEntry> {
    const key = `${kind}:${eventId}`
    const entry = { ...action, id: this.newId(), at: this.now(), by: actor.id, reason } as RefereeEntry
    const entries = [...(this.logs.get(key) ?? []), entry].slice(-REFEREE_LIMITS.entriesMax)
    this.logs.set(key, entries)
    await this.store.put(KEY + key, entries)
    await this.auditOnly(actor, action, reason, auditTarget)
    return entry
  }

  /**
   * The audit log's line for a re-credit of a finished event's points (`RankingsService.recredit`):
   * each member's difference and what their entry comes to, then the director's reason
   */
  async auditRecredit(
    actor: { username: string },
    kind: RefereeEvent,
    eventId: string,
    changes: readonly { username: string; delta: number; points: number }[],
    reason: string,
  ) {
    const list = changes.map((c) => `${c.username} ${c.delta > 0 ? '+' : ''}${c.delta} = ${c.points}`).join(', ')
    await this.audit.record({ by: actor.username, action: 'points:recredit', target: `${kind}:${eventId}`, note: [list, reason].filter(Boolean).join(' · ') })
  }

  /** Only the audit log: a ruling on a board of no event (a casual table's, `e2-t35`) */
  async auditOnly(actor: { username: string }, action: RefereeAction, reason: string, target: string) {
    await this.audit.record({ by: actor.username, action: AUDIT[action.action], target, note: [describe(action), reason].filter(Boolean).join(' · ') })
  }
}
