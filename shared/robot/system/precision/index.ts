import { contested } from '../gib/contested.ts'
import { defence } from '../gib/defence.ts'
import { fallback, forcedCall, silent } from '../gib/fallback.ts'
import { majors } from '../gib/majors.ts'
import { notrumpBooks, oneNotrumpExtras, type Ranges } from '../gib/notrump.ts'
import { slamAnswers, slamAsks, slamCheck } from '../gib/slam.ts'
import { soloway } from '../gib/soloway.ts'
import { strong } from '../gib/strong.ts'
import { tokens } from '../context.ts'
import type { Book, Range, System } from '../spec.ts'
import { club, REBID_1N, REBID_2N } from './club.ts'
import { diamond } from './diamond.ts'
import { openings } from './openings.ts'
import { twos } from './twos.ts'
import { LIMITED, limited, only, STRONG, without } from './util.ts'

/**
 * TKB in Precision (docs/systems/precision.md). Its own books for what makes the system different
 * (the openings, 1♣, 1♦, 2♣, 2♦); where it agrees with 2/1 it reads 2/1's books, with the ranges of
 * the limited opening (`limited`), so a change there reaches both: 1M, the weak twos and preempts,
 * notrump structures by range, when the opponents open, and the slam conventions.
 */

/** 1NT 13–15: everything on responder is two points higher than over 15–17 */
const ONE_NT: Ranges = { up: 0, weak: [0, 9], invite: [10, 11], game: [12, 17], slamTry: [16, 17], quant: [18, 19], slam: [20, 21], grand: [22, 23], top: 15 }
/** 2NT 22–24 */
const TWO_NT: Ranges = { up: 1, weak: [0, 1], invite: null, game: [2, 8], slamTry: [7, 8], quant: [9, 10], slam: [11, 13], grand: [14, 15], top: 24 }
/** Responder has at most 7 after the negative: what is above it cannot happen, and `limited` drops it */
const NEGATIVE: Range = [0, 7]
const OVER_REBID_1N: Ranges = { up: 0, weak: [0, 5], invite: [6, 7], game: [8, 15], slamTry: [14, 15], quant: [16, 17], slam: [18, 19], grand: [20, 21], top: REBID_1N[1] }
const OVER_REBID_2N: Ranges = { up: 1, weak: [0, 3], invite: null, game: [4, 10], slamTry: [9, 10], quant: [11, 12], slam: [13, 15], grand: [16, 17], top: REBID_2N[1] }
/** Opener asks a responder who bid notrump (a game force): Stayman and transfers from the strong side */
const OVER_RESPONSE_1N: Ranges = { up: 0, weak: [0, 15], invite: null, game: [16, 22], slamTry: [21, 22], quant: [23, 24], slam: [25, 27], grand: [28, 29], top: 10 }
const OVER_RESPONSE_2N: Ranges = { up: 1, weak: [0, 15], invite: null, game: [16, 18], slamTry: [17, 18], quant: [19, 20], slam: [21, 23], grand: [24, 25], top: 13 }

/** 2/1's Gerber answers without its strong 2♣ auction: here 2♣–2♦–2NT is the ask's answer */
/**
 * Opener over a notrump response keeps Stayman, and bids a long suit himself (`naturalOverNotrump`):
 * a transfer would make the weak hand declare. So the books for the transfers' answers go
 */
const askOnly = (books: readonly Book[], stayman: string): Book[] =>
  books.filter((book) => {
    const after = typeof book.after === 'string' ? tokens(book.after) : []
    return after.length <= 4 || after[4] === stayman
  })

const answers: Book[] = slamAnswers.map((book) => (Array.isArray(book.after) ? { ...book, after: book.after.filter((after: string) => !after.startsWith('2C')) } : book))

export const PRECISION: System = {
  id: 'precision',
  leadsOnlyShown: true,
  books: [
    ...answers,
    openings,
    ...club,
    ...limited(notrumpBooks(OVER_REBID_1N, '1C (P) 1D (P) 1N'), REBID_1N, NEGATIVE),
    ...limited(oneNotrumpExtras(OVER_REBID_1N, '1C (P) 1D (P) 1N'), REBID_1N, NEGATIVE),
    ...limited(notrumpBooks(OVER_REBID_2N, '1C (P) 1D (P) 2N'), REBID_2N, NEGATIVE),
    ...limited(askOnly(notrumpBooks(OVER_RESPONSE_1N, '1C (P) 1N'), '2C'), STRONG, [8, 10]),
    ...limited(askOnly(notrumpBooks(OVER_RESPONSE_2N, '1C (P) 2N'), '3C'), STRONG, [11, 40]),
    ...diamond,
    ...twos,
    ...notrumpBooks(ONE_NT, '1N'),
    ...oneNotrumpExtras(ONE_NT),
    ...notrumpBooks(TWO_NT, '2N'),
    ...only(strong, '2H', '2S', '3C', '3D', '3H', '3S', '4C', '4D'),
    ...limited(only(soloway, '1H', '1S'), LIMITED),
    ...limited(only(majors, '1H', '1S'), LIMITED),
    ...without(contested, '1C'),
    ...defence,
    ...slamAsks,
    silent,
    fallback,
  ],
  emergency: forcedCall,
  revise: slamCheck,
  cardGroups: {
    oneLevel: [{ after: '1C (P) 1D (P)' }, { after: '1C (P) 1S (P)' }],
    twoLevel: [{ after: '2C (P) 2D (P)' }, { after: '2D (P) 2N (P)' }],
    competitive: [{ after: '1C (X)' }, { after: '1C (2D)' }],
  },
}
