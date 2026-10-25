import type { Contract } from './auction.ts'
import type { Card } from './cards.ts'
import type { ChallengeScoring } from './challenge-scoring.ts'
import type { BoardState } from './game.ts'
import type { PublicUser } from './protocol.ts'

/**
 * A traveller (`e4-t32`, AC-4.12): everyone's result on the same board of an event (a challenge
 * now; team matches and pairs later), side by side. The server builds it and leaves out whatever
 * the viewer may not see (`worker/views.ts` `challengeTraveller`, ARCHITECTURE.md §4).
 */

/** One result on the board */
export interface TravellerEntry {
  /** The participant whose result this is */
  userId: string
  user?: PublicUser
  /** The board record (`/api/history/:id`), for its page and the side-by-side replay */
  boardId: string
  /** Null for a passed-out board */
  contract: Contract | null
  /** Who sat in the declarer's seat (the participant, or a robot) */
  declarer: PublicUser | null
  /** The opening lead, null when nobody led */
  lead: Card | null
  declarerTricks: number | null
  scoreNS: number
  /** The board's result in the event's scoring (`Traveller.scoring`), for those ranked */
  points?: number
}

export interface Traveller {
  kind: 'challenge'
  /** The challenge (later the match) the board belongs to */
  eventId: string
  /** The board's place in the deal set, 1-based */
  seq: number
  boardNo: number
  /** What `points` is in */
  scoring: ChallengeScoring
  entries: TravellerEntry[]
}

/** The opening lead of a board, if anyone led */
export const openingLead = (board: Pick<BoardState, 'play'>): Card | null => board.play[0]?.card ?? null
