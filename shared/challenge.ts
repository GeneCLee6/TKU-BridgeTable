import type { Contract } from './auction.ts'
import type { ChallengeScoring } from './challenge-scoring.ts'
import { isRobotKind, type PublicUser, type RobotKind } from './protocol.ts'

/**
 * A challenge's lifecycle and settings (docs/PRD/e7-challenges.md, ARCHITECTURE.md §5.5).
 * Creating, inviting and answering are C3 (`e7-t05`, `e7-t06`); this file only names the states
 * and the settings so the server, its storage and later the pages agree on them.
 *
 * - `pending`: invitations are out and nobody but the creator has accepted yet; the creator can
 *   already play
 * - `active`: someone besides the creator accepted; everyone who accepted can play
 * - `finished`: everyone who accepted is done, or the deadline passed; standings are final
 * - `cancelled`: the creator called it off before anyone else started, or too few people are left
 * - `expired`: the deadline passed and nobody but the creator accepted
 *
 * One deadline, counted from when the challenge is created, is for answering and for playing
 * alike: at the deadline play stops, as on BBO, and a board still being played is dropped. Only
 * those who played every board are ranked; nobody is scored for boards they did not play. Only
 * friends are invited (`e1-t19`), and the deals are always dealt at random, with Best Hand or Just
 * Declare as the only options, unless the creator challenges with boards they already played
 * (「用這副牌挑戰」), whose own results then count (社長, 2026-10-24).
 */
export const CHALLENGE_STATUSES = ['pending', 'active', 'finished', 'cancelled', 'expired'] as const
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number]

/** A challenge that can still change; the others are kept as they ended */
export const isOpenChallenge = (status: ChallengeStatus) => status === 'pending' || status === 'active'

/** Each participant: invited, then accepted or declined. The creator is accepted from the start */
export const PLAYER_STATUSES = ['invited', 'accepted', 'declined'] as const
export type PlayerStatus = (typeof PLAYER_STATUSES)[number]

/** Who sees the standings: only the participants, or the whole club once it is finished */
export const RANKING_VISIBILITIES = ['players', 'club'] as const
export type RankingVisibility = (typeof RANKING_VISIBILITIES)[number]

export interface ChallengeSettings {
  scoring: ChallengeScoring
  /**
   * The system TKB bids for every robot in the challenge, locked when it is created. Challenges
   * saved when robots had levels also have a `robotLevel`, which nothing reads
   */
  robotKind: RobotKind
  /** Rotate each deal so the participant holds the most points (`e7-t10`) */
  bestHand: boolean
  /** Robots bid; only boards the participant's side declares are kept (`e7-t11`) */
  justDeclare: boolean
  /** Days from creation until the one deadline, for answering and for playing */
  days: number
  ranking: RankingVisibility
  /**
   * The weekly club challenge (`e7-t23`): created by the club's schedule and open to every member.
   * Only the server sets it; a member sending it is refused like any unknown field
   */
  weekly?: boolean
}

export const CHALLENGE_LIMITS = {
  /** People invited besides the creator */
  invitedMin: 1,
  invitedMax: 20,
  boardsMin: 4,
  boardsMax: 16,
  boardsDefault: 8,
  daysMin: 1,
  daysMax: 7,
  daysDefault: 3,
} as const

const DAY_MS = 86_400_000

/** The defaults of AC-7.1: IMPs one on one, matchpoints with more */
export function defaultChallengeSettings(invited: number): ChallengeSettings {
  return {
    scoring: invited > 1 ? 'mp' : 'imp',
    robotKind: 'gib',
    bestHand: false,
    justDeclare: false,
    days: CHALLENGE_LIMITS.daysDefault,
    ranking: 'players',
  }
}

/** The one deadline: everyone answers and plays every board by then */
export const challengeDeadline = (createdAt: number, settings: ChallengeSettings) =>
  createdAt + settings.days * DAY_MS

/** Head to head: IMPs or total points; with more: matchpoints, cross-IMPs or total points (AC-7.1) */
export const scoringsFor = (invited: number): readonly ChallengeScoring[] =>
  invited > 1 ? ['mp', 'crossImp', 'total'] : ['imp', 'total']

/**
 * Checks the settings a creator sent (`e7-t05`): every field optional, falling back on
 * `defaultChallengeSettings`, nothing else allowed. There is no rule for unplayed boards: only
 * those who play every board are ranked. Returns the settings, or the first field that is wrong
 */
export function parseChallengeSettings(
  value: unknown,
  invited: number,
): { settings: ChallengeSettings } | { field: string } {
  const settings = defaultChallengeSettings(invited)
  if (value === undefined) return { settings }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { field: 'settings' }
  const { scoring, robotKind, bestHand, justDeclare, days, ranking, ...rest } = value as Record<
    string,
    unknown
  >
  const extra = Object.keys(rest)[0]
  if (extra !== undefined) return { field: extra }
  if (scoring !== undefined && !scoringsFor(invited).includes(scoring as ChallengeScoring)) return { field: 'scoring' }
  if (robotKind !== undefined && !isRobotKind(robotKind)) return { field: 'robotKind' }
  if (bestHand !== undefined && typeof bestHand !== 'boolean') return { field: 'bestHand' }
  if (justDeclare !== undefined && typeof justDeclare !== 'boolean') return { field: 'justDeclare' }
  const { daysMin, daysMax } = CHALLENGE_LIMITS
  if (days !== undefined && !(Number.isInteger(days) && (days as number) >= daysMin && (days as number) <= daysMax))
    return { field: 'days' }
  if (ranking !== undefined && !RANKING_VISIBILITIES.includes(ranking as RankingVisibility)) return { field: 'ranking' }
  return {
    settings: {
      ...settings,
      ...(scoring !== undefined && { scoring: scoring as ChallengeScoring }),
      ...(robotKind !== undefined && { robotKind }),
      ...(bestHand !== undefined && { bestHand }),
      ...(justDeclare !== undefined && { justDeclare }),
      ...(days !== undefined && { days: days as number }),
      ...(ranking !== undefined && { ranking: ranking as RankingVisibility }),
    },
  }
}

/** One participant as other participants see them: how far they got, never what they scored */
export interface ChallengePlayerView {
  /** Absent for an account deleted after the challenge ended */
  user?: PublicUser
  userId: string
  status: PlayerStatus
  answeredAt?: number
  startedAt?: number
  finishedAt?: number
  /** Boards played so far */
  played: number
  knownDeals: boolean
}

/** One ranked participant: their place, total and, for those allowed to see it, each board's result */
export interface ChallengeStandingView {
  userId: string
  /** Equal totals share a place and the next is skipped: 1, 2, 2, 4 */
  rank: number
  /** The average percentage for `mp`, the sum otherwise */
  total: number
  /** Each board's result in the scoring's unit, in board order (a row of the person × board matrix) */
  boards?: number[]
}

/**
 * The standings (`e7-t13`, `e7-t14`): only those who played every board are ranked; the others who
 * accepted are listed after them as 未完成 with how far they got. Before the end they are the live
 * standings of those who finished so far
 */
export interface ChallengeStandingsView {
  /** The challenge is finished and these are its final places */
  final: boolean
  /**
   * What `total` and `boards` are in: the challenge's scoring, or `total` when only one person
   * finished (nobody to compare with, so only their total score)
   */
  scoring: ChallengeScoring
  ranked: ChallengeStandingView[]
  /** Accepted participants who did not play every board, in the order they were invited */
  unfinished: { userId: string; played: number }[]
}

/** One participant's result on a board, as its traveller lists it */
export interface ChallengeTravellerEntry {
  userId: string
  /** The board record (`/api/history/:id`), for the replay */
  boardId: string
  scoreNS: number
  /** Null for a passed-out board */
  contract: Contract | null
  declarerTricks: number | null
}

/** Everyone's result on one board of the challenge */
export interface ChallengeTraveller {
  /** The board's place in the deal set, 1-based */
  seq: number
  boardNo: number
  entries: ChallengeTravellerEntry[]
}

/**
 * A challenge as a member sees it (`worker/views.ts` `challengeView`): settings, state and
 * everyone's progress, never the deals. The results follow the rules of §4 (`e7-t14`): a board's
 * traveller only for those who played that board (everyone after the end); the standings for
 * those who played every board, every participant after the end, and the whole club when the
 * ranking is `club` (the standings only, without the boards)
 */
export interface ChallengeView {
  id: string
  creatorId: string
  createdAt: number
  status: ChallengeStatus
  deadline: number
  startedAt?: number
  endedAt?: number
  settings: ChallengeSettings
  boards: number
  players: ChallengePlayerView[]
  standings?: ChallengeStandingsView
  travellers?: ChallengeTraveller[]
}
