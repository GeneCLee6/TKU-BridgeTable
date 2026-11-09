import { type ClubLogoRef, inspectLogo, LOGO_BURST, LOGO_MAX_BYTES, logoProblem, LOGOS_PER_SECOND, type LogoType } from '../shared/club-logo.ts'
import { DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import type { AuditLog } from './audit.ts'
import { readBytes } from './body.ts'
import { ClubError } from './errors.ts'
import { TokenBuckets } from './rate-limit.ts'
import type { Store } from './store.ts'

/**
 * A club's logo (AC-12.2, ARCHITECTURE.md §1「社團 Logo」), without Cloudflare APIs: kept in the
 * club's own object at `meta:logo` (no R2, no new binding), set and removed by its admins, served
 * to anyone at `GET /api/logo` (the sign-in page shows it). 淡江 keeps its lantern (DESIGN.md §6):
 * its admins cannot set one. Every picture passes `logoProblem` first (shared/club-logo.ts).
 */

export const LOGO_KEY = 'meta:logo'

/** A logo as kept: the bytes as the browser cropped and shrank them, after the structure check */
export interface StoredLogo {
  version: number
  type: LogoType
  /** Its side in pixels (a square) */
  size: number
  bytes: Uint8Array<ArrayBuffer>
}

/** What the pages need to name a logo: its version (the address changes with it), type and size */
export type LogoRef = ClubLogoRef

/** A year for the current version's address; any other is checked each time with the ETag */
export const LOGO_LONG_CACHE = 'public, max-age=31536000, immutable'
export const LOGO_CHECK_CACHE = 'public, no-cache'

const tooLarge = () => new ClubError('logoTooLarge', { max: LOGO_MAX_BYTES / 1024 }, 413)

/** The bytes checked: a plain square picture under the limit, or a ClubError */
export function checkedLogo(bytes: Uint8Array<ArrayBuffer>): { type: LogoType; size: number } {
  const problem = logoProblem(bytes)
  if (problem === 'logoTooLarge') throw tooLarge()
  if (problem) throw new ClubError(problem, {}, 415)
  const info = inspectLogo(bytes)!
  return { type: info.type, size: info.width }
}

/** An upload's bytes (`PUT /api/admin/logo`), refused as soon as it is over the limit */
export function readLogoUpload(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  return readBytes(request, LOGO_MAX_BYTES, tooLarge)
}

/**
 * A logo in an application's JSON (`logo`, base64; e12-t06): decoded and checked, or undefined when
 * none was sent. The text is measured before it is decoded
 */
export function logoFromBase64(value: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new ClubError('logoBadFormat', {}, 415)
  if (value.length > Math.ceil(LOGO_MAX_BYTES / 3) * 4) throw tooLarge()
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new ClubError('logoBadFormat', {}, 415)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  checkedLogo(bytes)
  return bytes
}

/**
 * The picture with its ETag (the version): a year when the address names the current version,
 * else checked each time; `If-None-Match` with the current version gets 304. No logo is 404
 * (`noLogo`) and the page shows the club's letter. Served only as the type its structure showed,
 * never sniffed, and the API's sandboxing CSP is added by the Worker (worker/security-headers.ts)
 */
export function logoResponse(logo: StoredLogo | undefined, request: Request, cache: 'public' | 'private' = 'public'): Response {
  if (!logo) throw new ClubError('noLogo', {}, 404)
  const etag = `"logo-${logo.version}"`
  const current = new URL(request.url).searchParams.get('v') === String(logo.version)
  const headers = {
    ETag: etag,
    'Cache-Control': cache === 'private' ? 'private, no-store' : current ? LOGO_LONG_CACHE : LOGO_CHECK_CACHE,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline; filename="logo"',
  }
  const asked = request.headers.get('If-None-Match')
  if (cache === 'public' && asked && asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(logo.bytes, {
    headers: { ...headers, 'Content-Type': logo.type, 'Content-Length': String(logo.bytes.length) },
  })
}

export class ClubLogos {
  private readonly store: Store
  private readonly audit: AuditLog
  private readonly clubId: string
  private readonly now: () => number
  private readonly limit: TokenBuckets

  constructor(store: Store, audit: AuditLog, clubId: string, now: () => number) {
    this.store = store
    this.audit = audit
    this.clubId = clubId
    this.now = now
    this.limit = new TokenBuckets(LOGO_BURST, LOGOS_PER_SECOND, now)
  }

  /** The logo with its bytes, for `GET /api/logo` */
  async get(): Promise<StoredLogo | undefined> {
    return this.store.get<StoredLogo>(LOGO_KEY)
  }

  /**
   * The logo's version, type and size (the manifest's icon, the back office). Read from storage
   * each time, not kept: a restore's later steps may bring one back, and both askers are rare
   * (the manifest is cached five minutes, the back office opens by hand)
   */
  async ref(): Promise<LogoRef | null> {
    const logo = await this.get()
    return logo ? refOf(logo) : null
  }

  /** An admin's new logo; `by` is their username for the audit trail */
  async set(by: string, bytes: Uint8Array<ArrayBuffer>): Promise<LogoRef> {
    if (this.clubId === DEFAULT_CLUB_ID) throw new ClubError('logoDefaultClub', {}, 403)
    if (!this.limit.take('club')) throw new ClubError('slowDown', {}, 429)
    const ref = await this.write(bytes)
    await this.audit.record({ by, action: 'club:logo', target: String(ref.version) })
    return ref
  }

  /** The logo the club was applied for with (the platform approved it): only when it has none yet */
  async provision(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.clubId === DEFAULT_CLUB_ID || (await this.ref())) return
    await this.write(bytes)
  }

  async clear(by: string): Promise<void> {
    if (this.clubId === DEFAULT_CLUB_ID) throw new ClubError('logoDefaultClub', {}, 403)
    if (!this.limit.take('club')) throw new ClubError('slowDown', {}, 429)
    const current = await this.ref()
    if (!current) return
    await this.store.delete(LOGO_KEY)
    await this.audit.record({ by, action: 'club:logoClear', target: String(current.version) })
  }

  private async write(bytes: Uint8Array<ArrayBuffer>): Promise<LogoRef> {
    const { type, size } = checkedLogo(bytes)
    const previous = await this.ref()
    const logo: StoredLogo = { version: Math.max(this.now(), (previous?.version ?? 0) + 1), type, size, bytes }
    await this.store.put(LOGO_KEY, logo)
    return refOf(logo)
  }
}

const refOf = ({ version, type, size }: StoredLogo): LogoRef => ({ version, type, size })
