import { isImportedBoardId } from '../shared/imports.ts'
import { SUPPORT_CATEGORIES, SUPPORT_LIMITS, type AdminSupportReport, type ForwardedSupport, type MySupportReport, type SupportCategory, type SupportReport, type SupportStatus } from '../shared/support.ts'
import { scrub } from '../shared/scrub.ts'
import type { AuditLog } from './audit.ts'
import { ClubError } from './errors.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * The support form (e12-t16, ARCHITECTURE.md §1「客服回報」). Reports are rows of the club's own
 * object, not in its backups, and forwarding one to the platform owner only marks it: the back office
 * asks each club for its forwarded ones when it opens, so no report is ever copied to another object
 * and deleting an account really deletes its reports. Only what shared/support.ts lists is kept; no
 * IP address.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS support_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    text TEXT NOT NULL,
    browser TEXT NOT NULL,
    version TEXT NOT NULL,
    board_id TEXT,
    table_id TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    resolved_at INTEGER,
    forwarded_at INTEGER,
    forwarded_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS support_by_member ON support_reports (user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS support_by_status ON support_reports (status, created_at)',
]

const HOUR_MS = 60 * 60_000
/** A record's or a table's id as the pages send it; anything else is not attached */
const ID_PATTERN = /^[\w-]{1,64}$/

interface Row {
  id: string
  user_id: string
  category: string
  text: string
  browser: string
  version: string
  board_id: string | null
  table_id: string | null
  created_at: number
  status: string
  resolved_at: number | null
  forwarded_at: number | null
  forwarded_by: string | null
}

export interface SupportConfig {
  clubId: string
  now: () => number
  newId: () => string
  audit: AuditLog
  usernameOf: (userId: string) => string | undefined
  /** Tells the club's admins of a new report */
  tellAdmins: (username: string) => Promise<unknown>
  /** Tells the platform owner of a forwarded report; none when the platform has no owner */
  tellOwner?: () => Promise<unknown>
  /** Tells a member their report was resolved: that alone, never by whom */
  tellReporter: (userId: string) => Promise<unknown>
  /** A notification that could not go; the report stands */
  failed: (what: string, error: unknown) => void
}

export class SupportService {
  private readonly sql: Sql
  private readonly config: SupportConfig

  constructor(sql: Sql, config: SupportConfig) {
    this.sql = sql
    this.config = config
  }

  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
  }

  /** A member's report: limited per member, with what the page attached and the request's browser */
  async submit(userId: string, input: Record<string, unknown>, browser: string): Promise<{ id: string }> {
    const category = input.category
    if (!SUPPORT_CATEGORIES.includes(category as SupportCategory)) throw new ClubError('badSupportCategory')
    const L = SUPPORT_LIMITS
    const text = String(input.text ?? '').trim()
    const length = [...text].length
    if (length < L.textMin || length > L.textMax) throw new ClubError('badSupportText', { min: L.textMin, max: L.textMax })
    const now = this.config.now()
    const count = (query: string, ...params: SqlValue[]) => this.sql.exec<{ n: number }>(query, ...params)[0]?.n ?? 0
    if (
      count('SELECT COUNT(*) AS n FROM support_reports WHERE user_id = ? AND created_at > ?', userId, now - HOUR_MS) >= L.perHour ||
      count("SELECT COUNT(*) AS n FROM support_reports WHERE user_id = ? AND status = 'open'", userId) >= L.openPerMember
    )
      throw new ClubError('tooManySupportReports', {}, 429)
    const id = this.config.newId()
    const attached = (value: unknown) => (typeof value === 'string' && ID_PATTERN.test(value) ? value : null)
    this.sql.exec(
      `INSERT INTO support_reports (id, user_id, category, text, browser, version, board_id, table_id, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      id,
      userId,
      category as SupportCategory,
      text,
      browser.slice(0, L.browserMax),
      typeof input.version === 'string' ? scrub(input.version, L.versionMax) : '',
      attached(input.boardId),
      attached(input.tableId),
      now,
    )
    try {
      await this.config.tellAdmins(this.config.usernameOf(userId) ?? '')
    } catch (error) {
      this.config.failed('supportNotify', error)
    }
    return { id }
  }

  private report(row: Row): SupportReport {
    return {
      id: row.id,
      clubId: this.config.clubId,
      category: row.category as SupportCategory,
      text: row.text,
      browser: row.browser,
      version: row.version,
      ...(row.board_id && { boardId: row.board_id }),
      ...(row.table_id && { tableId: row.table_id }),
      createdAt: row.created_at,
      status: row.status as SupportStatus,
      ...(row.resolved_at !== null && { resolvedAt: row.resolved_at }),
      ...(row.forwarded_at !== null && { forwardedAt: row.forwarded_at }),
    }
  }

  /**
   * What the admins and the back office get. An imported board is only its importer's (§4), for them
   * as for anyone, so they get a note and not an id that leads nowhere; going by the id, this covers
   * reports sent before it, and a board the member has since deleted
   */
  private forStaff(row: Row): SupportReport {
    const { boardId, ...rest } = this.report(row)
    if (!boardId) return rest
    return isImportedBoardId(boardId) ? { ...rest, boardImported: true } : { ...rest, boardId }
  }

  private row(id: string): Row {
    const row = this.sql.exec<Row>('SELECT * FROM support_reports WHERE id = ?', id)[0]
    if (!row) throw new ClubError('noSuchSupportReport', {}, 404)
    return row
  }

  /** The open ones oldest first (the next to answer), then the last resolved */
  private listed(where: string): Row[] {
    return [
      ...this.sql.exec<Row>(`SELECT * FROM support_reports WHERE status = 'open' ${where} ORDER BY created_at, id`),
      ...this.sql.exec<Row>(
        `SELECT * FROM support_reports WHERE status = 'resolved' ${where} ORDER BY resolved_at DESC, id LIMIT ?`,
        SUPPORT_LIMITS.resolvedListed,
      ),
    ]
  }

  /** The club's admin page. A deleted member's reports are gone with them, so every report has its author */
  list(): AdminSupportReport[] {
    return this.listed('').map((row) => ({
      ...this.forStaff(row),
      userId: row.user_id,
      username: this.config.usernameOf(row.user_id) ?? '',
      ...(row.forwarded_by && { forwardedBy: row.forwarded_by }),
    }))
  }

  /** A member's own reports, newest first: only rows of theirs, and only the fields of `MySupportReport` */
  mine(userId: string): MySupportReport[] {
    return this.sql
      .exec<Row>('SELECT * FROM support_reports WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ?', userId, SUPPORT_LIMITS.mineListed)
      .map((row) => ({
        id: row.id,
        category: row.category as SupportCategory,
        text: row.text,
        createdAt: row.created_at,
        status: row.status as SupportStatus,
        ...(row.resolved_at !== null && { resolvedAt: row.resolved_at }),
      }))
  }

  /** A notification that cannot go leaves the status as it is */
  private async tellResolved(userId: string) {
    try {
      await this.config.tellReporter(userId)
    } catch (error) {
      this.config.failed('supportResolvedNotify', error)
    }
  }

  private write(row: Row, status: SupportStatus) {
    if (row.status === status) return false
    this.sql.exec('UPDATE support_reports SET status = ?, resolved_at = ? WHERE id = ?', status, status === 'resolved' ? this.config.now() : null, row.id)
    // The oldest resolved ones go; open ones always stay
    if (status === 'resolved')
      this.sql.exec(
        `DELETE FROM support_reports WHERE status = 'resolved' AND id NOT IN
           (SELECT id FROM support_reports WHERE status = 'resolved' ORDER BY resolved_at DESC, id LIMIT ?)`,
        SUPPORT_LIMITS.resolvedKept,
      )
    return true
  }

  /** An admin resolves a report or opens it again */
  async setStatus(by: string, id: string, status: unknown) {
    if (status !== 'open' && status !== 'resolved') throw new ClubError('badMessage')
    const row = this.row(id)
    if (!this.write(row, status)) return
    await this.config.audit.record({ by, action: status === 'resolved' ? 'support:resolve' : 'support:reopen', target: id })
    // An admin who resolves their own report knows
    if (status === 'resolved' && this.config.usernameOf(row.user_id) !== by) await this.tellResolved(row.user_id)
  }

  /** An admin hands a report to the platform owner: it is marked, nothing is copied. Forwarding again does nothing */
  async forward(by: string, id: string) {
    const tell = this.config.tellOwner
    if (!tell) throw new ClubError('supportForwardOff', {}, 403)
    const row = this.row(id)
    if (row.forwarded_at !== null) return
    this.sql.exec('UPDATE support_reports SET forwarded_at = ?, forwarded_by = ? WHERE id = ?', this.config.now(), by, id)
    await this.config.audit.record({ by, action: 'support:forward', target: id })
    try {
      await tell()
    } catch (error) {
      this.config.failed('supportForwardNotify', error)
    }
  }

  /** What the back office sees of this club (RPC from 淡江's object): no member's id or name */
  forwarded(): ForwardedSupport[] {
    return this.listed('AND forwarded_at IS NOT NULL').map((row) => ({
      ...this.forStaff(row),
      forwardedAt: row.forwarded_at!,
      ...(row.forwarded_by && { forwardedBy: row.forwarded_by }),
    }))
  }

  /** The platform owner resolves a forwarded report or opens it again; one not forwarded does not exist for them */
  async setForwardedStatus(id: string, status: SupportStatus): Promise<boolean> {
    const row = this.sql.exec<Row>('SELECT * FROM support_reports WHERE id = ? AND forwarded_at IS NOT NULL', id)[0]
    if (!row) return false
    if (this.write(row, status) && status === 'resolved') await this.tellResolved(row.user_id)
    return true
  }

  /** Their own reports, in their account export */
  exportOf(userId: string): SupportReport[] {
    return this.sql.exec<Row>('SELECT * FROM support_reports WHERE user_id = ? ORDER BY created_at, id', userId).map((row) => this.report(row))
  }

  /** An account deleted: its reports go, and its name from the ones it forwarded */
  forget(userId: string, username: string) {
    this.sql.exec('DELETE FROM support_reports WHERE user_id = ?', userId)
    this.sql.exec('UPDATE support_reports SET forwarded_by = NULL WHERE forwarded_by = ?', username)
  }
}
