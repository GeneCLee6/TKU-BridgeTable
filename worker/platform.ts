import { CLUB_ID_PATTERN, clubPath, DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import { credentialText, toHalfWidth } from '../shared/halfwidth.ts'
import type { MessageCode, MessageParams } from '../shared/messages.ts'
import {
  CLUB_APPLICATION_LIMITS,
  clubIdProblem,
  type ClubApplicationInput,
  type ClubApplicationStatus,
  type ClubApplicationView,
  type ClubStatus,
  type ClubUsage,
  type PlatformClub,
  type PlatformView,
} from '../shared/platform.ts'
import { LIMITS, USERNAME_PATTERN, type Me } from '../shared/protocol.ts'
import type { AuditAction, AuditLog } from './audit.ts'
import { hashPassword } from './auth.ts'
import { ClubError } from './errors.ts'
import { noLog, type Logger } from './log.ts'
import { composeMail, isEmail, mailLang, normalizeEmail, type Mailer } from './mail.ts'
import { checkNewPassword } from './password-policy.ts'
import type { RegistrationLimit } from './register-limit.ts'
import type { Store } from './store.ts'

/**
 * The platform (e12-t05, e12-t06; ARCHITECTURE.md §1「平台與社團的申請」): the registry of the
 * clubs the Worker serves besides 淡江, the applications to open one, and the owner's back office.
 * It lives in 淡江's object (淡江 runs the platform, and its owner signs in there) under
 * `platform:club:<id>` and `platform:apply:<id>`; it never touches a Cloudflare API: the clubs'
 * own objects are reached through `ClubDirectory`, which `worker/club.ts` makes from their stubs.
 *
 * A club's own object keeps its own record too (`meta:club`: its name and status, set by
 * `provision` and `setStatus`), and that is what decides whether it answers: the registry is what
 * the Worker reads to route (worker/clubs.ts `ClubRegistryCache`) and what the back office lists.
 */

/** What a new club's object is told when it is approved: its name and its first admin */
export interface ClubSetup {
  name: string
  organisation: string
  contactEmail: string
  username: string
  passwordHash: string
  approvedAt: number
}

/** The clubs' own objects, as the platform reaches them (`worker/club.ts` makes it from their stubs) */
export interface ClubDirectory {
  /** Opens the club with its first admin; doing it again changes nothing */
  provision(clubId: string, setup: ClubSetup): Promise<void>
  /** Suspends (every session ends, every socket closes, the data stays) or serves the club again */
  setStatus(clubId: string, status: ClubStatus): Promise<void>
  usage(clubId: string): Promise<ClubUsage>
}

/** One club in the registry, as the Worker routes it */
export interface RegistryEntry {
  id: string
  status: ClubStatus
}

interface StoredClub {
  id: string
  name: string
  organisation: string
  contactEmail: string
  status: ClubStatus
  /** The application it was opened from, and its first admin's name */
  applicationId: string
  adminUsername: string
  approvedAt: number
  statusChangedAt?: number
}

interface StoredApplication extends ClubApplicationView {
  /** Only while it waits: deleted once decided */
  passwordHash?: string
  lang: string
}

const CLUB_KEY = 'platform:club:'
const APPLY_KEY = 'platform:apply:'

/** 淡江 in the back office: always served, never in the registry */
const DEFAULT_CLUB = { id: DEFAULT_CLUB_ID, name: '淡江橋藝社', organisation: '淡江大學', contactEmail: '' }

/** Three applications from one address an hour */
export const CLUB_APPLICATIONS_PER_ADDRESS = 3
export const CLUB_APPLICATION_WINDOW_MS = 60 * 60_000

/** The back office's address, for the owner; the new club's sign-in page (`/c/<id>`, e12-t04) for the mails */
export const clubAddress = (origin: string, clubId: string) => `${origin}${clubPath(clubId, '/')}`

/**
 * The platform owner (社長 2026-11-04): exactly one 淡江 account, named by the Worker setting
 * `PLATFORM_OWNER` (its user id), signed in to 淡江 with two-step sign-in on and the admin role.
 * Without the setting, or for anyone else, the back office does not exist (404), so nobody learns
 * who the owner is; the owner without two-step sign-in hears why
 */
export function requirePlatformOwner(me: Me | null, ownerId: string | undefined, clubId: string): Me {
  if (!ownerId || clubId !== DEFAULT_CLUB_ID || !me || me.id !== ownerId) throw new ClubError('noSuchApi', {}, 404)
  if (!me.admin || !me.twoFactor?.enabled) throw new ClubError('platformNeedsTwoFactor', {}, 403)
  return me
}

export interface PlatformConfig {
  now: () => number
  newId: () => string
  /** 淡江's audit trail (worker/audit.ts): the owner's every decision is in it */
  audit: AuditLog
  clubs: ClubDirectory
  /** Applications per address (`RegistrationLimit` with its own key) */
  limit: RegistrationLimit
  /** Mail to the applicant; none (RESEND unset) and nothing is mailed */
  mailer?: Mailer
  /** Clubs served without the registry (the `CLUBS` override): their ids cannot be applied for */
  extraClubs?: readonly string[]
  log?: Logger
}

const text = (value: unknown) => toHalfWidth(String(value ?? '')).trim()
const sized = (value: string, min: number, max: number, code: MessageCode) => {
  const length = [...value].length
  if (length < min || length > max) throw new ClubError(code, { min, max })
  return value
}

export class PlatformService {
  private readonly store: Store
  private readonly config: PlatformConfig
  private readonly log: Logger

  constructor(store: Store, config: PlatformConfig) {
    this.store = store
    this.config = config
    this.log = config.log ?? noLog
  }

  /** The clubs the Worker serves besides 淡江, with their status (worker/clubs.ts `ClubRegistryCache`) */
  async registry(): Promise<RegistryEntry[]> {
    return (await this.clubs()).map(({ id, status }) => ({ id, status }))
  }

  private async clubs(): Promise<StoredClub[]> {
    return [...(await this.store.list<StoredClub>(CLUB_KEY)).values()]
  }

  private async applications(): Promise<StoredApplication[]> {
    return [...(await this.store.list<StoredApplication>(APPLY_KEY)).values()]
  }

  // ── Applying (e12-t06) ─────────────────────────────────────────────────────────────────────

  /**
   * A club officer's application, no sign-in needed: checked, limited per address and while too
   * many wait, kept with the password's hash only. The applicant hears by mail when mail is on
   */
  async apply(input: Partial<ClubApplicationInput>, address: string): Promise<{ id: string; clubId: string }> {
    const from = await this.config.limit.key(address)
    if (await this.config.limit.blocked(from)) {
      this.log({ event: 'clubApplyLimited' })
      throw new ClubError('tooManyClubApplications', { minutes: CLUB_APPLICATION_WINDOW_MS / 60_000 }, 429)
    }
    const L = CLUB_APPLICATION_LIMITS
    const clubId = text(input.clubId).toLowerCase()
    const problem = clubIdProblem(clubId)
    if (problem) throw new ClubError(problem)
    const name = sized(text(input.name), L.nameMin, L.nameMax, 'badClubName')
    const organisation = sized(text(input.organisation), L.organisationMin, L.organisationMax, 'badOrganisation')
    const contactEmail = normalizeEmail(input.contactEmail)
    if (!isEmail(contactEmail)) throw new ClubError('badEmail')
    const reason = sized(String(input.reason ?? '').trim(), L.reasonMin, L.reasonMax, 'badReason')
    const username = credentialText(input.username)
    if (username.length < LIMITS.usernameMin || username.length > LIMITS.usernameMax || !USERNAME_PATTERN.test(username))
      throw new ClubError('badUsername', { min: LIMITS.usernameMin, max: LIMITS.usernameMax })
    const password = toHalfWidth(String(input.password ?? ''))
    checkNewPassword(password, username)
    const applications = await this.applications()
    const pending = applications.filter((a) => a.status === 'pending')
    if (
      (this.config.extraClubs ?? []).includes(clubId) ||
      (await this.store.get(`${CLUB_KEY}${clubId}`)) !== undefined ||
      pending.some((a) => a.clubId === clubId)
    )
      throw new ClubError('clubIdTaken', {}, 409)
    if (pending.length >= L.pendingMax) throw new ClubError('clubApplicationsFull', {}, 503)
    const application: StoredApplication = {
      id: this.config.newId(),
      clubId,
      name,
      organisation,
      contactEmail,
      reason,
      username,
      createdAt: this.config.now(),
      status: 'pending',
      passwordHash: await hashPassword(password),
      lang: mailLang(input.lang),
    }
    await this.config.limit.count(from)
    await this.store.put(`${APPLY_KEY}${application.id}`, application)
    this.log({ event: 'clubApplied', clubId })
    await this.mail(application, 'mailClubAppliedSubject', 'mailClubAppliedBody', { id: clubId, username })
    return { id: application.id, clubId }
  }

  // ── The back office (e12-t05) ──────────────────────────────────────────────────────────────

  /** Every club with its usage (one call to each club's object), and the applications */
  async view(): Promise<PlatformView> {
    const stored = await this.clubs()
    const entries = [
      { ...DEFAULT_CLUB, status: 'active' as ClubStatus, approvedAt: undefined },
      ...stored.sort((a, b) => a.approvedAt - b.approvedAt),
    ]
    const clubs: PlatformClub[] = await Promise.all(
      entries.map(async (club) => {
        let usage: ClubUsage | null = null
        try {
          usage = await this.config.clubs.usage(club.id)
        } catch (error) {
          this.log({ event: 'platformUsage', clubId: club.id, error: error instanceof Error ? error.message : String(error) })
        }
        return {
          id: club.id,
          name: club.name,
          status: club.status,
          organisation: club.organisation,
          contactEmail: club.contactEmail,
          ...(club.approvedAt !== undefined && { approvedAt: club.approvedAt }),
          usage,
        }
      }),
    )
    const sum = (pick: (u: ClubUsage) => number | null) => clubs.reduce((n, c) => n + (c.usage ? (pick(c.usage) ?? 0) : 0), 0)
    return {
      clubs,
      applications: this.listed(await this.applications()).map(view),
      totals: {
        members: sum((u) => u.members),
        filesBytes: sum((u) => u.filesBytes),
        backupBytes: sum((u) => u.backupBytes),
        historyRows: sum((u) => u.historyRows),
        storageBytes: sum((u) => u.storageBytes),
      },
    }
  }

  /** Pending oldest first, then the last decided, newest first */
  private listed(all: StoredApplication[]): StoredApplication[] {
    const pending = all.filter((a) => a.status === 'pending').sort((a, b) => a.createdAt - b.createdAt)
    const decided = all
      .filter((a) => a.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(0, CLUB_APPLICATION_LIMITS.decidedListed)
    return [...pending, ...decided]
  }

  /**
   * Approves an application: the club's object opens with the applicant as its first admin (with
   * the password they chose), then the registry serves it. If the club's object fails, nothing is
   * written here and approving again tries again (provisioning twice changes nothing)
   */
  async approve(owner: Me, applicationId: string, origin: string): Promise<PlatformView> {
    const application = await this.pending(applicationId)
    if ((await this.store.get(`${CLUB_KEY}${application.clubId}`)) !== undefined) throw new ClubError('clubIdTaken', {}, 409)
    const now = this.config.now()
    await this.config.clubs.provision(application.clubId, {
      name: application.name,
      organisation: application.organisation,
      contactEmail: application.contactEmail,
      username: application.username,
      passwordHash: application.passwordHash!,
      approvedAt: now,
    })
    const club: StoredClub = {
      id: application.clubId,
      name: application.name,
      organisation: application.organisation,
      contactEmail: application.contactEmail,
      status: 'active',
      applicationId: application.id,
      adminUsername: application.username,
      approvedAt: now,
    }
    await this.store.put(`${CLUB_KEY}${club.id}`, club)
    await this.decide(application, 'approved', now)
    await this.audit(owner, 'platform:approve', club.id, `${application.username} (${application.id})`)
    await this.mail(application, 'mailClubApprovedSubject', 'mailClubApprovedBody', {
      id: club.id,
      username: application.username,
      link: clubAddress(origin, club.id),
    })
    return this.view()
  }

  /** Rejects an application: its password's hash goes at once, the applicant hears why */
  async reject(owner: Me, applicationId: string, note: unknown): Promise<PlatformView> {
    const application = await this.pending(applicationId)
    const reason = String(note ?? '').trim().slice(0, CLUB_APPLICATION_LIMITS.noteMax)
    await this.decide(application, 'rejected', this.config.now(), reason)
    await this.audit(owner, 'platform:reject', application.clubId, reason || undefined)
    await this.mail(application, 'mailClubRejectedSubject', 'mailClubRejectedBody', { note: reason })
    return this.view()
  }

  /**
   * Suspends a club or serves it again. Its own object is told first (a suspension ends every
   * session there and closes every socket; nothing is deleted), then the registry; 淡江 never
   */
  async setStatus(owner: Me, clubId: string, status: unknown, note: unknown): Promise<PlatformView> {
    if (status !== 'active' && status !== 'suspended') throw new ClubError('badMessage')
    if (clubId === DEFAULT_CLUB_ID) throw new ClubError('cannotSuspendDefaultClub', {}, 403)
    const club = CLUB_ID_PATTERN.test(clubId) ? await this.store.get<StoredClub>(`${CLUB_KEY}${clubId}`) : undefined
    if (!club) throw new ClubError('unknownClub', {}, 404)
    if (club.status !== status) {
      await this.config.clubs.setStatus(clubId, status)
      await this.store.put(`${CLUB_KEY}${clubId}`, { ...club, status, statusChangedAt: this.config.now() } satisfies StoredClub)
      const reason = String(note ?? '').trim().slice(0, CLUB_APPLICATION_LIMITS.noteMax)
      await this.audit(owner, status === 'suspended' ? 'platform:suspend' : 'platform:unsuspend', clubId, reason || undefined)
    }
    return this.view()
  }

  private async pending(applicationId: string): Promise<StoredApplication> {
    const application = /^[\w-]{1,32}$/.test(applicationId) ? await this.store.get<StoredApplication>(`${APPLY_KEY}${applicationId}`) : undefined
    if (!application) throw new ClubError('noSuchClubApplication', {}, 404)
    if (application.status !== 'pending' || !application.passwordHash) throw new ClubError('clubApplicationDecided', {}, 409)
    return application
  }

  /** Marks it decided without its password's hash, and lets the oldest decided ones go */
  private async decide(application: StoredApplication, status: ClubApplicationStatus, at: number, note?: string) {
    const decided: StoredApplication = { ...application, status, decidedAt: at, ...(note && { note }) }
    delete decided.passwordHash
    await this.store.put(`${APPLY_KEY}${application.id}`, decided)
    const old = (await this.applications())
      .filter((a) => a.status !== 'pending')
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(CLUB_APPLICATION_LIMITS.decidedListed)
    for (const a of old) await this.store.delete(`${APPLY_KEY}${a.id}`)
  }

  private async audit(owner: Me, action: AuditAction, target: string, note?: string) {
    await this.config.audit.record({ by: owner.username, action, target, ...(note && { note }) })
  }

  /** Mail to the applicant; without a mailer nothing is sent, and a failure is only logged */
  private async mail(application: StoredApplication, subject: MessageCode, body: MessageCode, params: MessageParams) {
    const mailer = this.config.mailer
    if (!mailer) return
    try {
      await mailer.send(composeMail(application.contactEmail, mailLang(application.lang), subject, body, { club: application.name, ...params }))
    } catch (error) {
      this.log({ event: 'clubApplyMail', ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** An application without what only the server keeps */
function view(application: StoredApplication): ClubApplicationView {
  const { passwordHash: _hash, lang: _lang, ...rest } = application
  return rest
}
