/**
 * Feature flags (功能旗標, e11-t26): a feature can be built and shipped switched off, opened to the
 * club's officers first, then to everyone. Three levels, the narrowest winning:
 *
 * 1. **Site-wide** (全站): `FEATURE_DEFAULTS` below, in the code; changing one is a deploy.
 * 2. **Club** (社團): each club's admins pick a state on the admin page (`FeatureSettings`, stored in
 *    the club's own object as `meta:features`); none picked means the site-wide default.
 * 3. **Member** (使用者): the admins may also name members who get the feature whatever its state.
 *
 * A state is `off`, `officers` (admins and anyone with a permission, `isOfficer`) or `on`. The
 * server works out each member's flags (`enabledFeatures`) and sends them in `Me.features`; pages
 * ask `useFeature`, and the server checks the same function before doing what a flag guards.
 *
 * Adding a flag: add it to `FEATURE_FLAGS` and `FEATURE_DEFAULTS`, give it a name and a hint in
 * every language of `src/strings.ts` (`featureFlags`), and check it where the feature is.
 */

export const FEATURE_FLAGS = ['friends', 'forum', 'rankings', 'pairs', 'tournaments', 'publicLobby'] as const
export type FeatureFlag = (typeof FEATURE_FLAGS)[number]

export const FEATURE_STATES = ['off', 'officers', 'on'] as const
export type FeatureState = (typeof FEATURE_STATES)[number]

/** One flag as a club set it: its state, and members who get it anyway */
export interface FeatureSetting {
  state: FeatureState
  /** Member ids */
  users: string[]
}

/** What a club changed from the site-wide defaults */
export type FeatureSettings = Partial<Record<FeatureFlag, FeatureSetting>>

/**
 * The site-wide defaults.
 *
 * Friends (好友, AC-1.6): on. Hidden from 2026-10-27 while only club members used the site (社長),
 * opened again on 2026-11-03 (docs/ROADMAP.md L3). A club may still turn it off or give it to its
 * officers only: while a member does not have it the People tab, the profile card and the profile
 * page show no friend or block buttons and no "friends only" filter, the account page has no
 * friend-online setting and the push settings no friend-online group, nobody is put on top of the
 * People list, and the server sends them no friend-online notice. The friend and block lists, their
 * commands and their checks never depend on it; challenges and table invitations take any member
 * either way.
 *
 * Forum (論壇, E13 K1, ARCHITECTURE.md §5.19): the table's forum pages (`/forum/*`) and the header's
 * link. Off until the club opens it. The flag guards the table's pages only: `/api/forum/*` is
 * BridgeHall's forum too (the same posts), which its members already use, so the server checks
 * each forum route's role (roles.ts `forumRouteNeed`), not this flag.
 *
 * Pairs events (雙人賽, E9 J3, ARCHITECTURE.md §5.22): the `/pairs` pages and their API. Off until the
 * club tries one: it needs 10 members online at once. Without it `/api/pairs*` answers `pairsOff`;
 * tables of an event already being played go on.
 * Rankings (積分與實力評分, J2, ARCHITECTURE.md §5.21): the points boards (`/rankings`), the rating
 * on the profile and their APIs. Off until the club settles the rules. The ledger and the ratings
 * are kept from every finished event either way, so opening it shows everything since J2; admins
 * reach the page with the flag off to set the rules first.
 * Tournaments (比賽公告與報名, e9-t16, ARCHITECTURE.md §5.24): the `/tournaments` pages, their API and
 * the announcement notice. Off until the club announces its first one; admins reach the pages with
 * the flag off to announce and prepare it. A pairs event made from a tournament is played by its
 * players whether or not they have `pairs`.
 * Cross-club lobby (跨社團大廳, e12-t07, ARCHITECTURE.md §1「跨社團大廳」): the club joins it. A member
 * who has the flag sees the other clubs' open tables (`/clubs`) and may watch them (watching only:
 * no seat, no chat), and may mark a table they host "open to other clubs"; such a table is listed
 * for the other clubs only while its host has the flag. Off until the club's admins choose to join.
 */
export const FEATURE_DEFAULTS: Record<FeatureFlag, FeatureState> = {
  friends: 'on',
  forum: 'off',
  pairs: 'off',
  rankings: 'off',
  tournaments: 'off',
  publicLobby: 'off',
}

/** Kept for the code and tests written before flags: whether friends are on for everyone by default (true since L3) */
export const FRIENDS_ENABLED: boolean = FEATURE_DEFAULTS.friends === 'on'

/** Most members a club may name for one flag */
export const FEATURE_USERS_MAX = 50

export const isFeatureFlag = (value: unknown): value is FeatureFlag => FEATURE_FLAGS.includes(value as FeatureFlag)
export const isFeatureState = (value: unknown): value is FeatureState => FEATURE_STATES.includes(value as FeatureState)

/** Who counts as an officer (幹部) for `officers`: an admin, or anyone given a permission */
export function isOfficer(member: { admin: boolean; permissions: readonly string[] }): boolean {
  return member.admin || member.permissions.length > 0
}

/** A flag's state in a club: the club's choice, else the site-wide default */
export function featureState(flag: FeatureFlag, settings: FeatureSettings = {}): FeatureState {
  return settings[flag]?.state ?? FEATURE_DEFAULTS[flag]
}

/** Whether a member has a flag */
export function featureEnabled(
  flag: FeatureFlag,
  settings: FeatureSettings,
  member: { id: string; admin: boolean; permissions: readonly string[] },
): boolean {
  if (settings[flag]?.users.includes(member.id)) return true
  const state = featureState(flag, settings)
  return state === 'on' || (state === 'officers' && isOfficer(member))
}

/** Every flag a member has, in `FEATURE_FLAGS` order */
export function enabledFeatures(
  settings: FeatureSettings,
  member: { id: string; admin: boolean; permissions: readonly string[] },
): FeatureFlag[] {
  return FEATURE_FLAGS.filter((flag) => featureEnabled(flag, settings, member))
}

/** One flag as the admin page shows it */
export interface FeatureView {
  flag: FeatureFlag
  /** The site-wide default */
  default: FeatureState
  /** The club's state (its choice, or the default) */
  state: FeatureState
  /** Whether the club chose the state (false: it follows the default) */
  custom: boolean
  users: { id: string; username: string }[]
}
