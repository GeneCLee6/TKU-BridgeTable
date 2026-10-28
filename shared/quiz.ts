/**
 * 淡江橋館's practice questions (BridgeHall E6): a member's results and the editors' fixes. The
 * questions themselves are made in the handbook from its own text (its `src/lib/quiz.ts`); the
 * Worker only keeps what a member answered (e6-t04) and what an editor changed (e6-t06). The same
 * types are in the handbook's `src/lib/quizRecords.ts` (type parity, CLAUDE.md rule 10).
 *
 * A question's id is `slug/sectionId/blockIndex/rowIndex` for one made from a response table's row,
 * and `slug/sectionId/m-<random>` for one an editor wrote by hand.
 */

export const QUIZ_LIMITS = {
  /** Rounds kept for each member: an older one is dropped when a new one comes */
  roundsKept: 100,
  /** Questions in one round */
  answersMax: 50,
  idMax: 200,
  /** Characters of one meaning, choice or call */
  textMax: 2000,
  choicesMin: 2,
  choicesMax: 6,
  noteMax: 500,
  trailMax: 10,
  callsMax: 60,
  /** Fixes and hand-made questions together */
  fixesMax: 2000,
} as const

/** One question answered in a round */
export interface QuizAnswer {
  id: string
  slug: string
  right: boolean
}

/** What the handbook sends when a round ends */
export interface QuizRoundInput {
  /** The system profile the questions were made from */
  profileId: string
  answers: QuizAnswer[]
}

export interface QuizRound extends QuizRoundInput {
  id: string
  at: number
}

/** The row a fix to a made question was written against: when the text changes, the fix stops applying */
export interface QuizBasis {
  call: string
  answer: string
}

export interface QuizHand {
  spades: string
  hearts: string
  diamonds: string
  clubs: string
}

export interface QuizAuction {
  seats: [string, string, string, string]
  calls: (string | { call: string; note?: string })[]
}

/** A question an editor wrote by hand: what a meaning means, or which call a hand makes */
export interface ManualQuiz {
  kind: 'meaning' | 'call'
  /** The system profile it belongs to: shown only when practising that profile */
  profileId: string
  slug: string
  sectionId: string
  auction?: QuizAuction
  /** meaning: the call asked about */
  call?: string
  /** call: the hand that makes the call */
  hand?: QuizHand
  /** meaning: the meaning; call: the call */
  answer: string
  /** Every choice, the answer among them */
  choices: string[]
  level?: 'basic' | 'intermediate' | 'advanced'
  caption?: string
}

/** An editor's change to a made question: taken out, or its answer or choices changed */
export interface AutoQuizFixInput {
  source: 'auto'
  id: string
  basis: QuizBasis
  disabled?: boolean
  answer?: string
  /** Every choice, the answer among them; absent keeps the made ones (the answer swapped in) */
  choices?: string[]
  note?: string
}

export interface ManualQuizFixInput {
  source: 'manual'
  id: string
  quiz: ManualQuiz
  disabled?: boolean
  note?: string
}

export type QuizFixInput = AutoQuizFixInput | ManualQuizFixInput

/** A fix as kept: who saved it last (username) and when */
export type QuizFix = QuizFixInput & { by: string; at: number }
