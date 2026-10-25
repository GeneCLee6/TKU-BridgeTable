import type { MessageCode, MessageParams } from './messages.ts'
import type { BoardSummary } from './protocol.ts'

/**
 * A member's profile (個人檔案, AC-1.5): what they tell the club about themselves. Every field is
 * optional; the member edits it on "My account" (`PATCH /api/account/profile`) and other members
 * see it on the profile card and page (`GET /api/members/:id`). Avatars are generated in the
 * browser from the id and name (`e1-t18`) until uploads come (`e1-t34`).
 */

/** Self-rated level, lowest first: 初學者, 大專, 公開組, 橋士組 */
export const PROFILE_LEVELS = ['beginner', 'college', 'open', 'master'] as const
export type ProfileLevel = (typeof PROFILE_LEVELS)[number]
export const isProfileLevel = (value: unknown): value is ProfileLevel => PROFILE_LEVELS.includes(value as ProfileLevel)

export interface Profile {
  /** What the club calls them, e.g. their real name; the username stays the sign-in name */
  displayName?: string
  level?: ProfileLevel
  /** 常用制度, free text such as "淡江制度" or "2/1" */
  system?: string
  /** 自我介紹 */
  bio?: string
}

export const PROFILE_LIMITS = { displayNameMax: 16, systemMax: 40, bioMax: 300 } as const

/** Another member's profile as the card and the profile page show it */
export interface MemberProfile {
  id: string
  username: string
  profile: Profile
  /** Their latest boards the viewer may see, newest first, at most PROFILE_RECENT */
  recent: BoardSummary[]
}

export const PROFILE_RECENT = 10

export type ProfileResult = { profile: Profile } | { error: MessageCode; params: MessageParams }

/** Line breaks are kept in the bio only; other control characters are dropped everywhere */
const clean = (value: string, multiline: boolean) =>
  value
    .replace(multiline ? /[^\S\n]+/g : /\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()

function textField(value: unknown, max: number, multiline = false): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  // Strip control characters other than the newline, then collapse spaces
  // oxlint-disable-next-line no-control-regex
  const text = clean(value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ''), multiline)
  return [...text].length > max ? null : text
}

/**
 * Reads a profile from the browser: only the four fields, each optional, text within its limit.
 * An empty text or an empty level clears that field. Returns the message code of the first problem.
 */
export function parseProfile(value: unknown): ProfileResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'badMessage', params: {} }
  const { displayName, level, system, bio, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length) return { error: 'badMessage', params: {} }
  const profile: Profile = {}
  const name = textField(displayName, PROFILE_LIMITS.displayNameMax)
  if (name === null) return { error: 'profileNameTooLong', params: { max: PROFILE_LIMITS.displayNameMax } }
  if (name) profile.displayName = name
  if (level !== undefined && level !== null && level !== '') {
    if (!isProfileLevel(level)) return { error: 'badMessage', params: {} }
    profile.level = level
  }
  const sys = textField(system, PROFILE_LIMITS.systemMax)
  if (sys === null) return { error: 'profileSystemTooLong', params: { max: PROFILE_LIMITS.systemMax } }
  if (sys) profile.system = sys
  const about = textField(bio, PROFILE_LIMITS.bioMax, true)
  if (about === null) return { error: 'profileBioTooLong', params: { max: PROFILE_LIMITS.bioMax } }
  if (about) profile.bio = about
  return { profile }
}
