import type { RefereeEvent, RefereeRequest } from '../../shared/referee.ts'
import type { RulingRequest } from '../../shared/board-events.ts'
import type { ChallengeSettings, ChallengeView } from '../../shared/challenge.ts'
import type { ChallengeCommentsView } from '../../shared/challenge-comments.ts'
import type { ChallengeStatsView } from '../../shared/challenge-stats.ts'
import type { WeeklyChallengeSchedule, WeeklyChallengeView } from '../../shared/weekly-challenge.ts'
import type { DailyEventSettings, DailyEventView } from '../../shared/daily-event.ts'
import type { PairsSettings, PairsSummary, PairsView } from '../../shared/pairs.ts'
import type { TournamentSettings, TournamentSummary, TournamentView } from '../../shared/tournament.ts'
import type { LeaderboardView, LedgerEntry, PointsRules } from '../../shared/points.ts'
import type { RatingView } from '../../shared/rating.ts'
import { historyQueryString, type HistoryQuery } from '../../shared/history-query.ts'
import type { MessageParams } from '../../shared/messages.ts'
import type { MemberProfile, Profile } from '../../shared/profile.ts'
import type {
  TwoFactorSetup,
  AdminUser,
  ResetCode,
  Application,
  BoardRecord,
  BoardShare,
  ClubSettings,
  DirectPage,
  Favorite,
  FavoritesPage,
  FavoriteTag,
  HealthStatus,
  HistoryDays,
  HistoryPage,
  Me,
  MemberChange,
  Permission,
  RegisterOptions,
  OAuthName,
  OAuthPending,
  RegisterResult,
  RobotSpeed,
  SharedBoard,
} from '../../shared/protocol.ts'
import type { MatchSeat, MatchVugraph, Room, TeamMatchSettings, TeamMatchView } from '../../shared/team-match.ts'
import type { RulingKind, Team } from '../../shared/team-scoring.ts'
import type { Traveller } from '../../shared/traveller.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BookSyncRow } from '../../shared/robot/system/tku/sources.ts'
import type { IntegrityDays, IntegrityReport } from '../../shared/integrity.ts'

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
  | { action: 'next' }
import type { FeaturedBoard, FeaturedInput } from '../../shared/featured.ts'
import type { FeatureFlag, FeatureState, FeatureView } from '../../shared/features.ts'
import type { SessionInfo } from '../../shared/account.ts'
import type { PushKinds, PushView } from '../../shared/push.ts'
import type { PracticeSettings, SavedPractice } from '../../shared/practice.ts'
import type { PracticeSetInfo } from '../../shared/practice-sets/types.ts'

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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

/** An application with Google or LINE (e1-t31, e1-t32): which one, and the display name the applicant kept or typed */
export interface OAuthApplication {
  provider: OAuthName
  displayName: string
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** One provider's routes (Google e1-t31, LINE e1-t32) */
function oauthApi(name: OAuthName) {
  return {
    status: () => request<{ enabled: boolean }>(`/api/auth/${name}`),
    start: (returnTo: string) => post<{ url: string }>(`/api/auth/${name}/start`, { origin: window.location.origin, returnTo }),
    pending: () => request<OAuthPending>(`/api/auth/${name}/pending`),
    code: (code: string, lang: string) => post<{ user: Me; returnTo: string }>(`/api/auth/${name}/code`, { code, lang }),
    link: (password: string) => post<{ url: string }>(`/api/account/${name}/link`, { password, origin: window.location.origin }),
    unlink: (password: string) => post<{ user: Me }>(`/api/account/${name}/unlink`, { password }),
  }
}

export const api = {
  me: () => request<{ user: Me }>('/api/me'),
  /** The health check with the last hour's numbers, for the admin page's system status (e11-t22) */
  health: () => request<HealthStatus>('/api/health'),
  /**
   * Signs in. `code` is the second step (兩步驟登入, e11-t31) for accounts that turned it on: they
   * first get 401 twoFactorNeeded, then send the same with the code from the app or a recovery code
   */
  login: (username: string, password: string, code = '', lang?: string) =>
    post<{ user: Me }>('/api/login', code ? { username, password, code, lang } : { username, password }),
  /** The first account signs in at once; later ones wait for an admin to approve them */
  register: (username: string, password: string, inviteCode: string, note: string, turnstileToken?: string, oauth?: OAuthApplication) =>
    post<RegisterResult>('/api/register', {
      username,
      password,
      inviteCode,
      note,
      site: 'table',
      turnstileToken,
      ...(oauth && { [oauth.provider]: true, displayName: oauth.displayName }),
    }),
  /** What 申請加入 needs before it is sent (e1-t33): Turnstile's site key, or null when it is off */
  registerOptions: () => request<RegisterOptions>('/api/register/options'),
  /** 忘記密碼, step 1 (e1-t36): asks the admins, with the club's invite code; not for admin accounts */
  requestPasswordReset: (username: string, inviteCode: string) =>
    post<{ ok: true }>('/api/password/reset/request', { username, inviteCode }),
  /** 忘記密碼, step 2: the one-time code an admin handed over sets the new password */
  resetPassword: (username: string, code: string, password: string) =>
    post<{ ok: true }>('/api/password/reset', { username, code, password }),
  /** Whether the club sends mail (e1-t29); off when no mail provider is set */
  emailStatus: () => request<{ enabled: boolean }>('/api/email'),
  /** The link from the verification mail (e1-t29); no sign-in needed */
  verifyEmail: (token: string) => post<{ username: string; address: string }>('/api/email/verify', { token }),
  /** 忘記密碼 by email (e1-t30): the same answer whether or not the account has a verified address */
  requestEmailReset: (account: string, lang: string) => post<{ ok: true }>('/api/email/reset/request', { account, lang }),
  /** The link from the reset mail sets the new password */
  resetPasswordByEmail: (token: string, password: string) => post<{ username: string }>('/api/email/reset', { token, password }),
  /** Binds or changes the member's email (a link goes to it); an empty address removes it */
  setEmail: (address: string, password: string, lang: string) => post<{ user: Me }>('/api/account/email', { address, password, lang }),
  resendEmailVerification: (lang: string) => post<{ user: Me }>('/api/account/email/resend', { lang }),
  /** 兩步驟登入 (e11-t31): a secret to set up (admins), its first code turns it on, new recovery codes, off */
  twoFactor: {
    setup: (password: string) => post<TwoFactorSetup>('/api/account/2fa/setup', { password }),
    enable: (code: string) => post<{ user: Me; recoveryCodes: string[] }>('/api/account/2fa/enable', { code }),
    renew: (password: string, code: string) =>
      post<{ user: Me; recoveryCodes: string[] }>('/api/account/2fa/recovery', { password, code }),
    disable: (password: string, code: string, lang: string) =>
      post<{ user: Me }>('/api/account/2fa/disable', { password, code, lang }),
  },
  /**
   * Google sign-in (e1-t31): whether it is on; the address of Google for signing in or (with the
   * password) binding it, which the page then opens; what the browser waits for after coming back;
   * the two-step code after Google; unbinding
   */
  google: oauthApi('google'),
  /** LINE login (e1-t32): the same routes under /api/auth/line and /api/account/line */
  line: oauthApi('line'),
  /**
   * Push notifications (e1-t28): whether the club has them, the VAPID key, this member's devices and
   * choices; subscribing this browser (`PushSubscription.toJSON()` and the page's language),
   * removing a device, choosing kinds, a test push
   */
  push: {
    view: () => request<PushView>('/api/push'),
    subscribe: (subscription: PushSubscriptionJSON, lang: string) => post<PushView>('/api/push/subscribe', { ...subscription, lang }),
    unsubscribe: (id: string) => post<PushView>('/api/push/unsubscribe', { id }),
    kinds: (kinds: Partial<PushKinds>) => post<PushView>('/api/push/kinds', { kinds }),
    test: (id?: string) => post<{ devices: number }>('/api/push/test', id ? { id } : {}),
  },
  logout: () => post<{ ok: true }>('/api/logout'),
  changePassword: (current: string, next: string) => post<{ ok: true }>('/api/account/password', { current, next }),
  /** The account settings the server keeps (e1-t24) */
  setAccountPreferences: (preferences: {
    friendOnlineNotice?: boolean
    bookProfile?: string
    robotSpeed?: RobotSpeed
    /** Whether others see these on the member's profile page (e13-t08) */
    profileBoards?: boolean
    profilePosts?: boolean
  }) => post<{ user: Me }>('/api/account/preferences', preferences),
  /** Replaces the member's own profile (AC-1.5); empty fields clear it */
  setProfile: (profile: Profile) =>
    request<{ user: Me }>('/api/account/profile', { method: 'PATCH', body: JSON.stringify(profile) }),
  /** The member's own picture (e1-t34), already cropped and shrunk (`src/lib/avatarImage.ts`) */
  uploadAvatar: (picture: Blob) =>
    request<{ user: Me }>('/api/account/avatar', { method: 'PUT', body: picture, headers: { 'Content-Type': picture.type } }),
  /** Back to the default avatar */
  removeAvatar: () => request<{ user: Me }>('/api/account/avatar', { method: 'DELETE' }),
  /** Where the member is signed in, this device first (e11-t23) */
  sessions: () => request<{ sessions: SessionInfo[] }>('/api/account/sessions'),
  /** Signs one other device out */
  endSession: (id: string) => request<{ ok: true }>(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** 登出其他裝置: every session but this one ends */
  endOtherSessions: () => post<{ ended: number }>('/api/account/sessions/others'),
  /** The member's own data as a JSON file (e11-t27); a link downloads it */
  exportUrl: '/api/account/export',
  /** Deletes the member's own account; the answer signs this device out too */
  deleteAccount: (password: string) => post<{ ok: true }>('/api/account/delete', { password }),
  /** Another member's profile card with their latest boards the viewer may see */
  /** `hidden`: what the member keeps off their page for this viewer (e13-t08) */
  member: (id: string) => request<{ member: MemberProfile; hidden?: { boards: boolean; posts: boolean } }>(`/api/members/${encodeURIComponent(id)}`),
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
  /** How many boards a history search finds per Taiwan date, newest first (the side panel, e3-t48) */
  historyDays: (query: Partial<HistoryQuery>) => request<HistoryDays>(`/api/history/days?${historyQueryString(query)}`),
  record: (id: string) => request<{ record: BoardRecord }>(`/api/history/${encodeURIComponent(id)}`),
  /** A board's public link (e4-t38), for its players and the admins; null when it has none */
  boardShare: (id: string) => request<{ share: BoardShare | null }>(`/api/history/${encodeURIComponent(id)}/share`),
  /** Makes the board's public link, or gives the one it has */
  createBoardShare: (id: string) => post<{ share: BoardShare }>(`/api/history/${encodeURIComponent(id)}/share`),
  /** Takes the board's public link back: it stops working at once */
  revokeBoardShare: (id: string) => request<{ ok: true }>(`/api/history/${encodeURIComponent(id)}/share`, { method: 'DELETE' }),
  /** A board by its public link, signed in or not (e4-t38) */
  sharedBoard: (token: string) => request<{ shared: SharedBoard }>(`/api/share/${encodeURIComponent(token)}`),
  /** The records page's search as one PBN file (e4-t36): its first LIMITS.exportBoardsMax boards */
  exportPbnPath: (query: Partial<HistoryQuery>) => `/api/history/export.pbn?${historyQueryString(query)}`,
  /** A board's whole session at its table as one LIN file (e4-t37) */
  sessionLinPath: (id: string) => `/api/history/${encodeURIComponent(id)}/session.lin`,
  /** Everyone's result on the same board of its challenge, if the member may see it (e4-t32) */
  traveller: (id: string) => request<{ traveller: Traveller | null }>(`/api/history/${encodeURIComponent(id)}/traveller`),
  /** A director's ruling on a board (e2-t35), or null to take it back; the record comes back */
  ruleBoard: (id: string, ruling: RulingRequest | null) =>
    post<{ record: BoardRecord }>(`/api/history/${encodeURIComponent(id)}/ruling`, { ruling }),
  /** The tournament director's tools on a club event (e9-t17): the page is read again after */
  referee: (kind: RefereeEvent, id: string, request: RefereeRequest) =>
    post<{ ok: true }>(`/api/referee/${kind}/${encodeURIComponent(id)}`, request),
  /** Featured boards, newest first (e4-t30) */
  featured: () => request<{ featured: FeaturedBoard[] }>('/api/featured'),
  /** The club's practice sets, without their boards (e10-t16) */
  practiceSets: () => request<{ sets: PracticeSetInfo[] }>('/api/practice/sets'),
  /** The member's saved practice settings (存成我的設定, e10-t16) */
  practicePresets: () => request<{ presets: SavedPractice[] }>('/api/practice/presets'),
  savePracticePreset: (name: string, settings: PracticeSettings) =>
    post<{ presets: SavedPractice[] }>('/api/practice/presets', { name, settings }),
  removePracticePreset: (id: string) =>
    request<{ presets: SavedPractice[] }>(`/api/practice/presets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
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
  /** The member's own challenge record (`e7-t29`) */
  challengeStats: () => request<{ stats: ChallengeStatsView }>('/api/challenges/stats'),
  /** One board's discussion thread (`e7-t27`): the server decides who reads and who writes */
  challengeThread: (id: string, seq: number) =>
    request<{ thread: ChallengeCommentsView }>(`/api/challenges/${encodeURIComponent(id)}/boards/${seq}/comments`),
  postChallengeComment: (id: string, seq: number, text: string) =>
    post<{ thread: ChallengeCommentsView }>(`/api/challenges/${encodeURIComponent(id)}/boards/${seq}/comments`, { text }),
  removeChallengeComment: (id: string, seq: number, commentId: number) =>
    request<{ thread: ChallengeCommentsView }>(
      `/api/challenges/${encodeURIComponent(id)}/boards/${seq}/comments/${commentId}`,
      { method: 'DELETE' },
    ),
  /** The daily club event's page (`e9-t03`): today's, yesterday's and the earlier days */
  daily: () => request<{ daily: DailyEventView }>('/api/daily'),
  /** Pairs events (`e9-t10`–`e9-t13`, §5.22): the list, one event as the member may see it, and its actions */
  pairs: {
    list: () => request<{ pairs: PairsSummary[] }>('/api/pairs'),
    get: (id: string) => request<{ pairs: PairsView }>(`/api/pairs/${encodeURIComponent(id)}`),
    /** `format: 'individual'`: an individual event (e9-t15) */
    create: (settings: Partial<PairsSettings>, format?: 'individual') =>
      post<{ pairs: PairsView }>('/api/pairs', { settings, ...(format && { format }) }),
    /** No partner in an individual event: the member enters alone */
    enter: (id: string, partner?: string) => post<{ pairs: PairsView }>(`/api/pairs/${encodeURIComponent(id)}/enter`, { partner }),
    withdraw: (id: string, userId?: string) =>
      post<{ pairs: PairsView }>(`/api/pairs/${encodeURIComponent(id)}/withdraw`, { userId }),
    cancel: (id: string) => post<{ pairs: PairsView }>(`/api/pairs/${encodeURIComponent(id)}/cancel`),
    start: (id: string) => post<{ pairs: PairsView }>(`/api/pairs/${encodeURIComponent(id)}/start`),
  },
  /** Tournament announcements and entries (`e9-t16`, §5.24): admins announce and start, members enter */
  tournaments: {
    list: () => request<{ tournaments: TournamentSummary[] }>('/api/tournaments'),
    get: (id: string) => request<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}`),
    create: (settings: Partial<TournamentSettings>) => post<{ tournament: TournamentView }>('/api/tournaments', { settings }),
    update: (id: string, settings: Partial<TournamentSettings>) =>
      post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/settings`, { settings }),
    enter: (id: string, partners: string[], teamName?: string) =>
      post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/enter`, { partners, teamName }),
    answer: (id: string, accept: boolean) => post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/answer`, { accept }),
    withdraw: (id: string) => post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/withdraw`),
    remove: (id: string, entryId: string) =>
      post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/remove`, { entryId }),
    cancel: (id: string) => post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/cancel`),
    start: (id: string) => post<{ tournament: TournamentView }>(`/api/tournaments/${encodeURIComponent(id)}/start`),
  },
  /** Club points and ratings (J2): a period's board (`month=YYYY-MM`, `year=YYYY` or `season=<id>`) */
  rankings: (period: string) => request<{ board: LeaderboardView }>(`/api/rankings?${period}`),
  ledger: (userId: string, period: string) =>
    request<{ entries: LedgerEntry[] }>(`/api/rankings/ledger?user=${encodeURIComponent(userId)}&${period}`),
  savePointsRules: (rules: Partial<PointsRules>) => post<{ rules: PointsRules }>('/api/rankings/rules', rules),
  adjustPoints: (eventId: string, userId: string, points: number, reason: string) =>
    post<{ entry: LedgerEntry }>('/api/rankings/adjust', { eventId, userId, points, reason }),
  rating: (userId: string) => request<{ rating: RatingView }>(`/api/ratings/${encodeURIComponent(userId)}`),
  setRatingHidden: (hidden: boolean) => post<{ rating: RatingView }>('/api/ratings/visibility', { hidden }),
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
  /** The Vugraph page (`e8-t18`): both rooms, the score and the watchers' chat; never for a player while it is on */
  matchVugraph: (id: string) => request<{ vugraph: MatchVugraph }>(`/api/matches/${encodeURIComponent(id)}/vugraph`),
  matchVugraphChat: (id: string, text: string) =>
    post<{ vugraph: MatchVugraph }>(`/api/matches/${encodeURIComponent(id)}/vugraph/chat`, { text }),

  admin: {
    users: () => request<{ users: AdminUser[] }>('/api/admin/users'),
    applications: () => request<{ applications: Application[] }>('/api/admin/applications'),
    approve: (id: string) => post<{ user: Me }>(`/api/admin/applications/${id}/approve`),
    reject: (id: string) => request<{ ok: true }>(`/api/admin/applications/${id}`, { method: 'DELETE' }),
    setPermissions: (id: string, permissions: Permission[]) =>
      post<{ ok: true }>(`/api/admin/users/${id}/permissions`, { permissions }),
    createUser: (username: string, password: string) => post<{ user: Me }>('/api/admin/users', { username, password }),
    resetPassword: (id: string, password: string) => post<{ ok: true }>(`/api/admin/users/${id}/password`, { password }),
    /** 忘記密碼 (e1-t36): approving answers the one-time code to hand over */
    approveReset: (id: string) => post<ResetCode>(`/api/admin/users/${id}/password-reset`),
    declineReset: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}/password-reset`, { method: 'DELETE' }),
    /** Every role and permission change from the members section, in one request */
    updateMembers: (changes: MemberChange[]) => post<{ ok: true }>('/api/admin/members', { changes }),
    setAdmin: (id: string, admin: boolean) => post<{ ok: true }>(`/api/admin/users/${id}/admin`, { admin }),
    deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
    /** 兩步驟登入 (e11-t31): turns a member's second step off, for one who lost the phone */
    clearTwoFactor: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}/2fa`, { method: 'DELETE' }),
    settings: () => request<{ settings: ClubSettings }>('/api/admin/settings'),
    saveSettings: (settings: Partial<ClubSettings>) => post<{ settings: ClubSettings }>('/api/admin/settings', settings),
    /** The feature flags (e11-t26): the club's state of each and the members who get it anyway */
    features: () => request<{ features: FeatureView[] }>('/api/admin/features'),
    /** `state: null` follows the site-wide default again */
    setFeature: (flag: FeatureFlag, state: FeatureState | null, usernames: string[]) =>
      post<{ features: FeatureView[] }>('/api/admin/features', { flag, state, usernames }),
    closeTable: (id: string) => request<{ ok: true }>(`/api/admin/tables/${id}`, { method: 'DELETE' }),
    /** The club's robot against 淡江橋館: articles edited online since its rules were checked (e5-t45) */
    bookSync: () => request<{ sync: BookSyncRow[] }>('/api/admin/book-sync'),
    /** The anti-cheating report (`e11-t25`): one browser or one small network, and what those accounts played together */
    integrity: (days: IntegrityDays) => request<{ report: IntegrityReport }>(`/api/admin/integrity?days=${days}`),
    /** The weekly club challenge's schedule (`e7-t23`) */
    weeklyChallenge: () => request<{ weekly: WeeklyChallengeView }>('/api/admin/weekly-challenge'),
    saveWeeklyChallenge: (schedule: Partial<WeeklyChallengeSchedule>) =>
      post<{ weekly: WeeklyChallengeView }>('/api/admin/weekly-challenge', schedule),
    /** Turns the daily club event on or off, and its robots' system (`e9-t02`) */
    saveDailyEvent: (settings: Partial<DailyEventSettings>) =>
      post<{ daily: DailyEventView }>('/api/admin/daily-event', settings),
  },
}
