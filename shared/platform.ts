import { CLUB_ID_PATTERN, DEFAULT_CLUB_ID } from './clubs.ts'
import type { PlatformNoticeView } from './notices.ts'
import type { ForwardedSupport } from './support.ts'

/**
 * The platform (e12-t05, e12-t06; ARCHITECTURE.md §1「平台與社團的申請」): the clubs it runs, the
 * applications to open one and what its owner sees. The platform owner is one account of 淡江 (the
 * Worker setting `PLATFORM_OWNER`, with two-step sign-in on); the registry lives in 淡江's object.
 * Pure types and checks, shared by the Worker and the pages.
 */

/** A club's state: served, or suspended (its API answers `clubSuspended`, its sockets are closed, its data kept) */
export type ClubStatus = 'active' | 'suspended'
/**
 * Where club applications go (e12-t06): always 淡江's object, which keeps the platform's registry.
 * The Worker sends it there whichever club a request names, and another club's object refuses it
 */
export const CLUB_APPLY_API = '/api/clubs/apply'
/** The application page: 淡江's, also when opened under another club's address (`/c/<id>/clubs/apply`) */
export const CLUB_APPLY_PAGE = '/clubs/apply'

export const CLUB_STATUSES: readonly ClubStatus[] = ['active', 'suspended']

/**
 * Ids no club may take: the platform's own words and paths, names that would pass for an official
 * page, and the object names `shared/clubs.ts` uses. 淡江's `tku` is taken by 淡江
 */
export const RESERVED_CLUB_IDS: readonly string[] = [
  DEFAULT_CLUB_ID,
  'club',
  'clubs',
  'platform',
  'admin',
  'admins',
  'api',
  'app',
  'apply',
  'assets',
  'about',
  'account',
  'auth',
  'bbo',
  'c',
  'default',
  'email',
  'help',
  'login',
  'logout',
  'mail',
  'new',
  'null',
  'undefined',
  'official',
  'owner',
  'privacy',
  'public',
  'register',
  'robot',
  'root',
  'share',
  'signup',
  'staff',
  'static',
  'support',
  'system',
  'table',
  'tables',
  'terms',
  'tkb',
  'www',
  'ws',
]

/** The application's limits (characters) */
export const CLUB_APPLICATION_LIMITS = {
  nameMin: 2,
  nameMax: 40,
  organisationMin: 2,
  organisationMax: 80,
  reasonMin: 10,
  reasonMax: 1000,
  /** Applications waiting at once; more are turned away until the owner decides some */
  pendingMax: 50,
  /** Applications decided that the back office still lists */
  decidedListed: 50,
  /** A rejection's note */
  noteMax: 500,
}

/** What is wrong with a wanted club id, or null when it may be asked for (uniqueness is the server's) */
export function clubIdProblem(id: string): 'badClubId' | 'clubIdReserved' | null {
  if (!CLUB_ID_PATTERN.test(id)) return 'badClubId'
  if (RESERVED_CLUB_IDS.includes(id)) return 'clubIdReserved'
  return null
}

/** `POST /api/clubs/apply`: a club officer asks for a club; the account named becomes its first admin */
export interface ClubApplicationInput {
  clubId: string
  name: string
  organisation: string
  contactEmail: string
  reason: string
  /** The applicant's account in the new club (its first admin); the password is kept only as its hash, until the owner decides */
  username: string
  password: string
  /** The language of the mails to the applicant */
  lang?: string
  turnstileToken?: string
}

export type ClubApplicationStatus = 'pending' | 'approved' | 'rejected'

/** An application as the owner sees it (no password hash) */
export interface ClubApplicationView {
  id: string
  clubId: string
  name: string
  organisation: string
  contactEmail: string
  reason: string
  username: string
  createdAt: number
  status: ClubApplicationStatus
  decidedAt?: number
  /** Why it was rejected, as the owner wrote it */
  note?: string
}

/** A club's size, as its own object counts it (rough: storage sizes are what the runtime reports) */
export interface ClubUsage {
  members: number
  admins: { id: string; username: string }[]
  /** Tables open now */
  tables: number
  /** Boards in its history */
  boards: number
  /** Its Durable Object's SQLite database (bytes) */
  storageBytes: number
  /** Its pictures and e-books in R2 (`clubs/<id>/`, 淡江 the bucket's root; bytes) */
  filesBytes: number
  /** Its daily backups in R2 (bytes), or null without the bucket */
  backupBytes: number | null
  /** Its rows in the D1 history copy, or null without D1 */
  historyRows: number | null
}

/** One club in the back office */
export interface PlatformClub {
  id: string
  name: string
  status: ClubStatus
  organisation: string
  contactEmail: string
  /** When it was approved (淡江: none) */
  approvedAt?: number
  /** Its usage, or null when its object did not answer */
  usage: ClubUsage | null
}

/** `GET /api/platform`: the back office */
export interface PlatformView {
  clubs: PlatformClub[]
  /** Pending first (oldest first), then the last decided */
  applications: ClubApplicationView[]
  /** The platform's notices, newest first (e12-t15) */
  notices: PlatformNoticeView[]
  /** Support reports the clubs' admins forwarded (e12-t16): open ones first, oldest first; asked of each club when the page opens */
  support: ForwardedSupport[]
  /** The whole bucket and database: the clubs' sums (R2 and D1's free allowances are for the account) */
  totals: { members: number; filesBytes: number; backupBytes: number; historyRows: number; storageBytes: number }
}

/** `GET /api/clubs/apply`: whether applications are open (the owner is set) and Turnstile's site key */
export interface ClubApplyOptions {
  open: boolean
  turnstileSiteKey: string | null
}
