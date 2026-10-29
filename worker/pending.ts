import type { AuditLog } from './audit.ts'
import { randomId } from './auth.ts'
import { isSectionId, isSlug, pendingOf, type SectionLike } from './book.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * The 待確認 panel's data (BridgeHall e8-t06, AC-8.2). A 待確認 note itself stays in the content
 * (`pending` on a section, paragraph, call row or rule; the handbook shows it); this keeps who looks
 * into it, how far it is, a remark and, when it is closed, on what grounds. One record per note
 * someone has touched, at `pendingmeta:<slug>/<sectionId>/<n>` (n: the note's place among the ones
 * that belong directly to that section, as in PendingNoteRef). Notes nobody has touched are 未處理
 * and have no record.
 *
 * A note is closed only by publishing the convention without it (e8-t08: the panel opens the
 * editor, the change goes through review): publishing calls `published()`, which closes the records
 * whose note is gone (moved to `pendingdone:<time>-<id>`, newest listed first) and moves the others
 * along when notes before them in their section came or went. Records follow their note by its
 * section and text, so a reworded note starts again as 未處理.
 */

/** 未處理, 處理中, 已確認 (closed, only by publishing), 擱置 */
export const PENDING_STATUSES = ['open', 'working', 'confirmed', 'parked'] as const
export type PendingStatus = (typeof PENDING_STATUSES)[number]

export interface PendingMeta {
  slug: string
  sectionId: string
  /** As PendingNoteRef.index, when the record was last written */
  index: number
  /** The note's text when the record was last written: how the record finds its note again */
  text: string
  status: PendingStatus
  /** The editor looking into it (a username); absent when nobody is */
  assignee?: string
  /** A remark, for the editors */
  note?: string
  /** 關閉依據: why the note can go (who confirmed what, and where); asked for before the editor opens */
  resolution?: string
  updatedAt: number
  updatedBy: string
  /** Set when publishing removed the note */
  closedAt?: number
  closedBy?: string
  /** The published version that removed it */
  closedVersion?: number
}

export const PENDING_LIMITS = { noteMax: 500, closedListed: 100 }

const key = (slug: string, sectionId: string, index: number) => `pendingmeta:${slug}/${sectionId}/${index}`
const clip = (value: unknown) => String(value ?? '').trim().slice(0, PENDING_LIMITS.noteMax)

export class PendingService {
  private readonly store: Store
  private readonly now: () => number
  private readonly audit: AuditLog
  private lastStamp = 0

  constructor(store: Store, audit: AuditLog, now: () => number = Date.now) {
    this.store = store
    this.audit = audit
    this.now = now
  }

  /** GET /api/book/pending: the open records (by convention and place) and the newest closed ones */
  async list(): Promise<{ open: PendingMeta[]; closed: PendingMeta[] }> {
    const open = [...(await this.store.list<PendingMeta>('pendingmeta:')).values()]
    const closed = await this.store.list<PendingMeta>('pendingdone:', { reverse: true, limit: PENDING_LIMITS.closedListed })
    return { open, closed: [...closed.values()] }
  }

  /**
   * PUT /api/book/pending/:slug/:sectionId/:index (an editor's): the note's status, assignee, remark
   * and closing grounds. `text` is the note as the editor saw it. 已確認 is not set here: a note
   * is closed by publishing the convention without it.
   */
  async save(
    actor: { username: string },
    slug: string,
    sectionId: string,
    index: number,
    body: { text?: unknown; status?: unknown; assignee?: unknown; note?: unknown; resolution?: unknown },
  ): Promise<PendingMeta> {
    if (!isSlug(slug) || !isSectionId(sectionId) || !Number.isInteger(index) || index < 0 || index > 999)
      throw new ClubError('badContent', { reason: '待確認的位置不對' })
    const text = String(body.text ?? '').trim()
    if (!text || text.length > 2_000) throw new ClubError('badContent', { reason: '待確認缺少原文' })
    const status = body.status as PendingStatus
    if (!PENDING_STATUSES.includes(status) || status === 'confirmed')
      throw new ClubError('badContent', { reason: '待確認的狀態只能是未處理、處理中或擱置' })
    const meta: PendingMeta = { slug, sectionId, index, text, status, updatedAt: this.now(), updatedBy: actor.username }
    const assignee = clip(body.assignee).slice(0, 40)
    const note = clip(body.note)
    const resolution = clip(body.resolution)
    if (assignee) meta.assignee = assignee
    if (note) meta.note = note
    if (resolution) meta.resolution = resolution
    await this.store.put(key(slug, sectionId, index), meta)
    await this.audit.record({ by: actor.username, action: 'book:pending', target: `${slug}/${sectionId}/${index}`, note: `${status}${assignee ? ` → ${assignee}` : ''}` })
    return meta
  }

  /**
   * After a convention is published: records whose note is gone are closed (已確認), with the
   * reviewer, the version and, when the panel gave none, the version's note as grounds; the others
   * move to their note's new place.
   */
  async published(actor: { username: string }, slug: string, convention: Record<string, unknown> | null, version: number, versionNote: string) {
    if (!convention) return
    const records = await this.store.list<PendingMeta>(`pendingmeta:${slug}/`)
    if (!records.size) return
    const sections = (Array.isArray(convention.sections) ? convention.sections : []) as SectionLike[]
    const notes = pendingOf(sections)
    const taken = new Set<string>()
    const time = this.now()
    const moved: PendingMeta[] = []
    // Same place first, so two notes with the same text keep their own records
    const ordered = [...records.values()].sort((a, b) => a.sectionId.localeCompare(b.sectionId) || a.index - b.index)
    for (const meta of ordered) {
      const candidates = notes.filter((n) => n.sectionId === meta.sectionId && n.text === meta.text && !taken.has(`${n.sectionId}/${n.index}`))
      const found = candidates.find((n) => n.index === meta.index) ?? candidates[0]
      if (found) {
        taken.add(`${found.sectionId}/${found.index}`)
        moved.push({ ...meta, index: found.index })
        continue
      }
      const closed: PendingMeta = {
        ...meta,
        status: 'confirmed',
        closedAt: time,
        closedBy: actor.username,
        closedVersion: version,
      }
      if (!closed.resolution && versionNote) closed.resolution = versionNote.slice(0, PENDING_LIMITS.noteMax)
      await this.store.put(`pendingdone:${this.orderedId()}`, closed)
    }
    for (const oldKey of records.keys()) await this.store.delete(oldKey)
    for (const meta of moved) await this.store.put(key(meta.slug, meta.sectionId, meta.index), meta)
  }

  private orderedId() {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1)
    return `${String(this.lastStamp).padStart(14, '0')}-${randomId(3)}`
  }
}
