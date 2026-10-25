import type { ChallengeSettings, ChallengeView } from '../../shared/challenge.ts'
import type { WeeklyChallengeSchedule, WeeklyChallengeView } from '../../shared/weekly-challenge.ts'
import { historyQueryString, type HistoryQuery } from '../../shared/history-query.ts'
import type { MessageParams } from '../../shared/messages.ts'
import type { MemberProfile, Profile } from '../../shared/profile.ts'
import type {
  AdminUser,
  Application,
  BoardRecord,
  ClubSettings,
  DirectPage,
  Favorite,
  FavoritesPage,
  FavoriteTag,
  HistoryPage,
  Me,
  MemberChange,
  Permission,
  RegisterResult,
} from '../../shared/protocol.ts'
import type { MatchSeat, Room, TeamMatchSettings, TeamMatchView } from '../../shared/team-match.ts'
import type { RulingKind, Team } from '../../shared/team-scoring.ts'
import type { Traveller } from '../../shared/traveller.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BookSyncRow } from '../../shared/robot/system/tku/sources.ts'

/** The seat actions of a team match before the start; `action` is the last part of the path */
export type MatchSeatAction =
  | { action: 'invite'; room: Room; seat: Seat; userId: string }
  | { action: 'answer'; accept: boolean }
  | { action: 'move'; from: MatchSeat; to: MatchSeat }
  | { action: 'leave' }
  | { action: 'clear'; room: Room; seat: Seat }
  | { action: 'robot'; room: Room; seat: Seat }

/** What the host (替補 also a captain) does while a match is played (§5.8, `e8-t14`–`e8-t16`) */
export type MatchPlayAction =
  | { action: 'rule'; seq: number; ruling: RulingKind; team: Team; reason: string }
  | { action: 'pause'; paused: boolean }
  | { action: 'abandon' }
  | { action: 'replace'; room: Room; seat: Seat; userId: string }
  | { action: 'sitin'; room: Room; seat: Seat }
import type { FeaturedBoard, FeaturedInput } from '../../shared/featured.ts'

/** HTTP calls to the Worker. The session lives in an HttpOnly cookie, so no token is handled here. */

/** An error from the API; `code` and `params` translate it (shared/messages.ts) */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly params: MessageParams
  constructor(message: string, status: number, code = '', params: MessageParams = {}) {
    super(message)
    this.status = status
    this.code = code
    this.params = params
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data.code ?? '', data.params ?? {})
  return data as T
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

export const api = {
  me: () => request<{ user: Me }>('/api/me'),
  login: (username: string, password: string) => post<{ user: Me }>('/api/login', { username, password }),
  /** The first account signs in at once; later ones wait for an admin to approve them */
  register: (username: string, password: string, inviteCode: string, note: string) =>
    post<RegisterResult>('/api/register', { username, password, inviteCode, note, site: 'table' }),
  /** 忘記密碼: needs the club's invite code; not for admin accounts */
  resetPassword: (username: string, inviteCode: string, password: string) =>
    post<{ ok: true }>('/api/password/reset', { username, inviteCode, password }),
  logout: () => post<{ ok: true }>('/api/logout'),
  changePassword: (current: string, next: string) => post<{ ok: true }>('/api/account/password', { current, next }),
  /** The account settings the server keeps (e1-t24) */
  setAccountPreferences: (preferences: { friendOnlineNotice: boolean }) => post<{ user: Me }>('/api/account/preferences', preferences),
  /** Replaces the member's own profile (AC-1.5); empty fields clear it */
  setProfile: (profile: Profile) =>
    request<{ user: Me }>('/api/account/profile', { method: 'PATCH', body: JSON.stringify(profile) }),
  /** Another member's profile card with their latest boards the viewer may see */
  member: (id: string) => request<{ member: MemberProfile }>(`/api/members/${encodeURIComponent(id)}`),
  /** One page of the conversation with another member, oldest first; `before` pages back (AC-1.7) */
  directMessages: (userId: string, before?: number) =>
    request<DirectPage>(`/api/messages/${encodeURIComponent(userId)}${before ? `?before=${before}` : ''}`),
  /** One page of history, newest first; `page` counts from 1 */
  history: (all: boolean, page = 1, size = 20) => {
    const query = new URLSearchParams({ page: String(page), size: String(size) })
    if (all) query.set('scope', 'all')
    return request<HistoryPage>(`/api/history?${query}`)
  },
  /** One page of a history search (`shared/history-query.ts`) */
  searchHistory: (query: Partial<HistoryQuery>) => request<HistoryPage>(`/api/history/search?${historyQueryString(query)}`),
  record: (id: string) => request<{ record: BoardRecord }>(`/api/history/${encodeURIComponent(id)}`),
  /** Everyone's result on the same board of its challenge, if the member may see it (e4-t32) */
  traveller: (id: string) => request<{ traveller: Traveller | null }>(`/api/history/${encodeURIComponent(id)}/traveller`),
  /** Featured boards, newest first (e4-t30) */
  featured: () => request<{ featured: FeaturedBoard[] }>('/api/featured'),
  /** A board's feature, or null when it is not featured */
  featuredBoard: (id: string) => request<{ featured: FeaturedBoard | null }>(`/api/featured/${encodeURIComponent(id)}`),
  /** Features a board or edits its feature; needs the `boardCurate` permission */
  saveFeatured: (id: string, input: FeaturedInput) =>
    post<{ featured: FeaturedBoard }>(`/api/featured/${encodeURIComponent(id)}`, input),
  unfeature: (id: string) => request<{ ok: true }>(`/api/featured/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 「我的收藏」: one page of the member's favorites, filtered as history is plus `tag` (AC-4.4) */
  favorites: (query: Partial<HistoryQuery>) => request<FavoritesPage>(`/api/favorites?${historyQueryString(query)}`),
  /** Every board the member keeps, for the star buttons */
  favoriteIds: () => request<{ ids: string[] }>('/api/favorites/ids'),
  /** The member's favorite of one board (null if not kept) and their tags */
  favorite: (id: string) => request<{ favorite: Favorite | null; tags: FavoriteTag[] }>(`/api/favorites/${encodeURIComponent(id)}`),
  /** Keeps a board or changes its note and tags; what is left out stays as it was */
  saveFavorite: (id: string, change: { note?: string; tags?: string[] } = {}) =>
    request<{ favorite: Favorite }>(`/api/favorites/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(change) }),
  removeFavorite: (id: string) => request<{ ok: true }>(`/api/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The challenges the member is in, newest first (§5.5) */
  challenges: () => request<{ challenges: ChallengeView[] }>('/api/challenges'),
  /** One challenge as the member may see it, with the standings and travellers they are allowed */
  challenge: (id: string) => request<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}`),
  /** Challenges friends (`e7-t17`); the server checks everything and answers with the new challenge */
  createChallenge: (invitees: string[], boards: number, settings: Partial<ChallengeSettings>) =>
    post<{ challenge: ChallengeView }>('/api/challenges', { invitees, boards, settings }),
  /** 「用這副牌挑戰」 (`e7-t22`): boards the member played with robots; their results count */
  challengeWithBoards: (invitees: string[], fromBoards: string[], settings: Partial<ChallengeSettings>) =>
    post<{ challenge: ChallengeView }>('/api/challenges', { invitees, fromBoards, settings }),
  /** One-click rematch (`e7-t21`): answers with the new challenge */
  rematchChallenge: (id: string) => post<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}/rematch`),
  answerChallenge: (id: string, accept: boolean) =>
    post<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}/answer`, { accept }),
  cancelChallenge: (id: string) => post<{ challenge: ChallengeView }>(`/api/challenges/${encodeURIComponent(id)}/cancel`),

  /** The team matches the member hosts or has a seat in, newest first (§5.8) */
  matches: () => request<{ matches: TeamMatchView[] }>('/api/matches'),
  match: (id: string) => request<{ match: TeamMatchView }>(`/api/matches/${encodeURIComponent(id)}`),
  createMatch: (settings?: Partial<TeamMatchSettings>) => post<{ match: TeamMatchView }>('/api/matches', { settings }),
  matchSettings: (id: string, settings: Partial<TeamMatchSettings>) =>
    post<{ match: TeamMatchView }>(`/api/matches/${encodeURIComponent(id)}/settings`, { settings }),
  cancelMatch: (id: string) => post<{ match: TeamMatchView }>(`/api/matches/${encodeURIComponent(id)}/cancel`),
  /** The host starts the match (`e8-t07`): both rooms open and deal board 1 */
  startMatch: (id: string) => post<{ match: TeamMatchView | null }>(`/api/matches/${encodeURIComponent(id)}/start`),
  /**
   * A seat action (`e8-t04`, `e8-t05`): answers with the match as the member now sees it, null once
   * they may not (they declined or left)
   */
  matchSeat: (id: string, { action, ...body }: MatchSeatAction) =>
    post<{ match: TeamMatchView | null }>(`/api/matches/${encodeURIComponent(id)}/${action}`, body),
  /** Rulings, the pause, abandoning, substitutes and robots sitting in, while the match is played */
  matchPlay: (id: string, { action, ...body }: MatchPlayAction) =>
    post<{ match: TeamMatchView | null }>(`/api/matches/${encodeURIComponent(id)}/${action}`, body),

  admin: {
    users: () => request<{ users: AdminUser[] }>('/api/admin/users'),
    applications: () => request<{ applications: Application[] }>('/api/admin/applications'),
    approve: (id: string) => post<{ user: Me }>(`/api/admin/applications/${id}/approve`),
    reject: (id: string) => request<{ ok: true }>(`/api/admin/applications/${id}`, { method: 'DELETE' }),
    setPermissions: (id: string, permissions: Permission[]) =>
      post<{ ok: true }>(`/api/admin/users/${id}/permissions`, { permissions }),
    createUser: (username: string, password: string) => post<{ user: Me }>('/api/admin/users', { username, password }),
    resetPassword: (id: string, password: string) => post<{ ok: true }>(`/api/admin/users/${id}/password`, { password }),
    /** Every role and permission change from the members section, in one request */
    updateMembers: (changes: MemberChange[]) => post<{ ok: true }>('/api/admin/members', { changes }),
    setAdmin: (id: string, admin: boolean) => post<{ ok: true }>(`/api/admin/users/${id}/admin`, { admin }),
    deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
    settings: () => request<{ settings: ClubSettings }>('/api/admin/settings'),
    saveSettings: (settings: Partial<ClubSettings>) => post<{ settings: ClubSettings }>('/api/admin/settings', settings),
    closeTable: (id: string) => request<{ ok: true }>(`/api/admin/tables/${id}`, { method: 'DELETE' }),
    /** The club's robot against 淡江橋館: articles edited online since its rules were checked (e5-t45) */
    bookSync: () => request<{ sync: BookSyncRow[] }>('/api/admin/book-sync'),
    /** The weekly club challenge's schedule (`e7-t23`) */
    weeklyChallenge: () => request<{ weekly: WeeklyChallengeView }>('/api/admin/weekly-challenge'),
    saveWeeklyChallenge: (schedule: Partial<WeeklyChallengeSchedule>) =>
      post<{ weekly: WeeklyChallengeView }>('/api/admin/weekly-challenge', schedule),
  },
}
