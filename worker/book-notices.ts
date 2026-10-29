import {
  CLUB_PROFILE_ID,
  type ClubMember,
  type Me,
  type Notification,
  type NotificationKind,
  type ProfileOverride,
  type SystemProfile,
} from '../shared/protocol.ts'
import { isString } from './book.ts'
import type { ProfileService } from './profiles.ts'
import { managesTeam } from './roles.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'
import type { TeamService } from './teams.ts'

/**
 * The handbook's notifications in the club's notification centre (BridgeHall E8 e8-t10, e8-t11 and
 * E2 e2-t08). Who hears what:
 *
 * - A convention is published (`bookPublished`): whoever follows it (關注), the members of every
 *   active team's and partnership's profile that plays it, and whoever sent that draft for review.
 * - Among them, the members of a profile that overrides a section the publish changed hear
 *   `bookOverrideChanged` instead, naming their profile, so they can check the override still holds.
 *   The handbook says which sections changed (`changedSections`): only it has the bundled
 *   conventions to compare with. A publish that names none (the robot's hand conditions) is quiet.
 * - A draft is sent for review (`bookReviewRequested`): every reviewer. Sent back (`bookReturned`):
 *   whoever sent it.
 * - A captain suggests a partnership drops one of its overrides (`bookSuggestUnify`): both partners.
 *
 * Nobody hears about their own doing. Following is kept as `bookfollow:<slug>:<userId>` (value
 * `true`), so it is in the daily backup with the rest of `book*`.
 */
export interface BookNoticeDeps {
  notify: (userId: string, kind: NotificationKind, params: Notification['params']) => Promise<unknown>
  members: () => ClubMember[]
  /** Admins and `bookReview` holders */
  reviewerIds: () => string[]
  /** The Club replaces these after a backup is restored, so they are asked for each time */
  teams: () => TeamService
  profiles: () => ProfileService
}

const followKey = (slug: string, userId: string) => `bookfollow:${slug}:${userId}`

/** How many section ids a publish may name; more are ignored */
export const CHANGED_SECTIONS_MAX = 2_000
/** How long a convention's name in a suggestion may be */
const NAME_MAX = 60

/**
 * One override, as a link or a suggestion names it (e2-t08): `row:<slug>:<sectionId>:<block>:<row>`,
 * `section:<slug>:<sectionId>` or `meta:<slug>`. TKU-BridgeHall src/lib/teams.ts has the same.
 */
export function overrideRef(o: ProfileOverride): string {
  if (o.kind === 'row') return `row:${o.slug}:${o.sectionId}:${o.blockIndex}:${o.rowIndex}`
  if (o.kind === 'section') return `section:${o.slug}:${o.sectionId}`
  return `meta:${o.slug}`
}

export class BookNotices {
  private readonly store: Store
  private readonly deps: BookNoticeDeps

  constructor(store: Store, deps: BookNoticeDeps) {
    this.store = store
    this.deps = deps
  }

  // ── Following (e8-t10) ─────────────────────────────────────────────────────────────────────

  async following(userId: string, slug: string): Promise<boolean> {
    return (await this.store.get<boolean>(followKey(slug, userId))) === true
  }

  async setFollowing(userId: string, slug: string, body: { following?: unknown }): Promise<boolean> {
    if (typeof body.following !== 'boolean') throw new ClubError('badContent', { reason: 'following 要是 true 或 false' })
    if (body.following) await this.store.put(followKey(slug, userId), true)
    else await this.store.delete(followKey(slug, userId))
    return body.following
  }

  private async followers(slug: string): Promise<string[]> {
    return [...(await this.store.list<boolean>(`bookfollow:${slug}:`)).keys()].map((key) => key.slice(key.lastIndexOf(':') + 1))
  }

  // ── Publishing (e8-t10, e8-t11) ────────────────────────────────────────────────────────────

  /**
   * After a convention is published. `changedSections` is what the handbook sent: the ids of the
   * sections that changed, with the sections around them; not an array means say nothing.
   */
  async published(
    actor: Me,
    publish: { slug: string; name: string; version: number; requestedBy?: string; changedSections: unknown },
  ) {
    if (!Array.isArray(publish.changedSections)) return
    const changed = new Set(publish.changedSections.filter(isString).slice(0, CHANGED_SECTIONS_MAX))
    const { slug, name, version } = publish
    const known = new Set(this.deps.members().map((m) => m.id))
    const told = new Set<string>([actor.id])
    const tell = async (userId: string, kind: NotificationKind, params: Notification['params']) => {
      if (told.has(userId) || !known.has(userId)) return
      told.add(userId)
      await this.deps.notify(userId, kind, params)
    }

    const plays: string[] = []
    for (const { profile, members, playsIt } of await this.ownedProfiles(slug)) {
      if (!playsIt) continue
      const touched = profile.overrides.some(
        (o) => o.slug === slug && (o.kind === 'row' || o.kind === 'section') && changed.has(o.sectionId),
      )
      if (!touched) {
        plays.push(...members)
        continue
      }
      for (const userId of members)
        await tell(userId, 'bookOverrideChanged', { slug, name, profileId: profile.id, profile: profile.name, username: actor.username })
    }
    const requester = publish.requestedBy ? this.idOf(publish.requestedBy) : undefined
    const everyone = [...(await this.followers(slug)), ...plays, ...(requester ? [requester] : [])]
    for (const userId of everyone) await tell(userId, 'bookPublished', { slug, name, version, username: actor.username })
  }

  /** Every active team's and partnership's profile, its members, and whether it plays `slug` */
  private async ownedProfiles(slug: string) {
    const profiles = this.deps.profiles()
    const owners = await this.deps.teams().profileOwners()
    const cache = new Map<string, SystemProfile | null>()
    const load = async (id: string) => {
      if (!cache.has(id)) cache.set(id, await profiles.get(id).catch(() => null))
      return cache.get(id) ?? null
    }
    // The deepest profile that lists the convention decides; one nobody lists is played
    const playsIt = async (profile: SystemProfile) => {
      let at: SystemProfile | null = profile
      for (let depth = 0; at && depth < 5; depth++) {
        const value = at.adopted[slug]
        if (value) return value === 'on'
        if (at.scope === 'club') break
        at = await load(at.parentId ?? CLUB_PROFILE_ID)
      }
      return true
    }
    const found: { profile: SystemProfile; members: string[]; playsIt: boolean }[] = []
    for (const [profileId, owner] of owners) {
      const members = owner.team ? (owner.team.archived ? [] : owner.team.memberIds) : owner.pair.status === 'active' ? owner.pair.userIds : []
      if (!members.length) continue
      const profile = await load(profileId)
      if (profile) found.push({ profile, members, playsIt: await playsIt(profile) })
    }
    return found
  }

  private idOf(username: string) {
    return this.deps.members().find((m) => m.username === username)?.id
  }

  // ── Review (e8-t10; F2 moved telling the editor here) ─────────────────────────────────────

  async reviewRequested(actor: Me, draft: { slug: string; name: string }) {
    for (const userId of this.deps.reviewerIds())
      if (userId !== actor.id) await this.deps.notify(userId, 'bookReviewRequested', { slug: draft.slug, name: draft.name, username: actor.username })
  }

  async returned(actor: Me, draft: { slug: string; name: string; requestedBy?: string }) {
    const userId = draft.requestedBy ? this.idOf(draft.requestedBy) : undefined
    if (userId && userId !== actor.id) await this.deps.notify(userId, 'bookReturned', { slug: draft.slug, name: draft.name, username: actor.username })
  }

  // ── 建議統一 (e2-t08) ─────────────────────────────────────────────────────────────────────

  /**
   * POST /api/club/teams/:id/suggest-unify: the team's captain (or an editor) asks one of its
   * partnerships to drop an override and play the team's version; both partners hear it, with a
   * link to that override on the compare page, where they may drop it at once
   */
  async suggestUnify(actor: Me, teamId: string, body: { pairId?: unknown; ref?: unknown; name?: unknown }) {
    const { team, pairs } = await this.deps.teams().team(teamId)
    if (!managesTeam(actor, team)) throw new ClubError('noPermission', {}, 403)
    if (team.archived) throw new ClubError('teamArchived', {}, 409)
    const pair = pairs.find((p) => p.id === body.pairId)
    if (!pair) throw new ClubError('pairGone', {}, 404)
    const profile = await this.deps.profiles().get(pair.profileId)
    const override = profile.overrides.find((o) => overrideRef(o) === body.ref)
    if (!override) throw new ClubError('badContent', { reason: '這對搭檔的制度集沒有這條覆寫（可能已經改回）' })
    // The convention's name as the captain's handbook shows it: a bundled one is only known there
    const name = (isString(body.name) && body.name.trim().slice(0, NAME_MAX)) || override.slug
    const params = { pairId: pair.id, profileId: profile.id, ref: overrideRef(override), slug: override.slug, name, team: team.name, username: actor.username }
    for (const userId of pair.userIds) if (userId !== actor.id) await this.deps.notify(userId, 'bookSuggestUnify', params)
  }
}
