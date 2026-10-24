import type { ChallengeScoring, UnfinishedRule } from './challenge-scoring.ts'
import type { RobotKind } from './protocol.ts'

/**
 * A challenge's lifecycle and settings (docs/PRD/e7-challenges.md, ARCHITECTURE.md §5.5).
 * Creating, inviting and answering are C3 (`e7-t05`, `e7-t06`); this file only names the states
 * and the settings so the server, its storage and later the pages agree on them.
 *
 * - `pending`: invitations are out; fewer than two participants have accepted yet
 * - `active`: two or more have accepted; those who did can play
 * - `finished`: everyone who accepted is done, or their time ran out; standings are final
 * - `cancelled`: the creator called it off before anyone started, or too few people are left
 * - `expired`: the accept deadline passed with fewer than two participants
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
  unfinished: UnfinishedRule
  /** Every robot in the challenge is the same kind and level, locked when it is created */
  robotKind: RobotKind
  /** A robot level from E6 (`e6-t21`); checked when a challenge is created (`e7-t05`) */
  robotLevel: string
  /** Rotate each deal so the participant holds the most points (`e7-t10`) */
  bestHand: boolean
  /** Robots bid; only boards the participant's side declares are kept (`e7-t11`) */
  justDeclare: boolean
  /** Days the invited have to answer */
  acceptDays: number
  /** Days each participant has to play, from the moment they accept */
  finishDays: number
  ranking: RankingVisibility
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
    unfinished: 'avgMinus',
    robotKind: 'gib',
    robotLevel: 'open',
    bestHand: false,
    justDeclare: false,
    acceptDays: CHALLENGE_LIMITS.daysDefault,
    finishDays: CHALLENGE_LIMITS.daysDefault,
    ranking: 'players',
  }
}

/** When the invited must have answered by */
export const acceptDeadline = (createdAt: number, settings: ChallengeSettings) =>
  createdAt + settings.acceptDays * DAY_MS

/** When a participant must have played every board by */
export const finishDeadline = (acceptedAt: number, settings: ChallengeSettings) =>
  acceptedAt + settings.finishDays * DAY_MS
