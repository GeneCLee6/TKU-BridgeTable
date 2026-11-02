import type { PublicUser } from './protocol.ts'

/**
 * Each board's discussion thread of a challenge (`e7-t27`, ARCHITECTURE.md §5.5). Only those who
 * may already see the board's traveller read it (§4: those who played every board, every
 * participant once it ended), so a comment never tells someone still playing how a board went;
 * only those who played every board write in it.
 */

export const CHALLENGE_COMMENT_MAX = 500
/** The newest comments of one board that are sent; a club's thread is far shorter */
export const CHALLENGE_COMMENTS_SHOWN = 200

export interface ChallengeComment {
  id: number
  userId: string
  /** Absent for an account deleted since (its comments go with it, so only for a moment) */
  user?: PublicUser
  text: string
  at: number
  /** The viewer may delete it: their own, or any for an admin */
  removable: boolean
}

export interface ChallengeCommentsView {
  /** Oldest first */
  comments: ChallengeComment[]
  /** The viewer played every board and may write */
  canPost: boolean
}
