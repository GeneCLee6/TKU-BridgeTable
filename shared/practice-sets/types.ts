import type { Hands, Seat } from '../cards.ts'

/**
 * The types of the club's practice sets (`index.ts`), apart so that the browser can name them
 * without importing the sets themselves: only the Worker imports `index.ts`, whose files hold the hands
 */

export type PracticeVulnerability = 'None' | 'NS' | 'EW' | 'All'

/** One problem as a file holds it */
export interface PracticeProblemFile {
  id: string
  dealer: Seat
  vulnerability: PracticeVulnerability
  /** The deal in PBN, `N:<north> <east> <south> <west>` */
  hands: string
  category: string
  /** What the problem teaches, in Traditional Chinese; shown once the auction is over */
  note: string
}

/** A problem read: the board number gives its dealer and vulnerability (`boardNoFor`) */
export interface PracticeProblem {
  id: string
  boardNo: number
  hands: Hands
  category: string
  note: string
}

export interface PracticeSet {
  id: string
  problems: PracticeProblem[]
}

/** A set as the practice dialog lists it: no hands */
export interface PracticeSetInfo {
  id: string
  count: number
  categories: string[]
}
