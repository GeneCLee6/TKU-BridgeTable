import { isBid, levelOf, strainOf, type Call } from '../../shared/auction.ts'

/**
 * Calls are never translated (社長, 2026-10-25): Pass, X, XX and 1♣ … 7NT in every language. A
 * passed-out board is "All pass" where the auction is told and "--" where a contract goes.
 */

export const ALL_PASS = 'All pass'
export const PASSED_OUT = '--'

const STRAIN_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' } as const

/** Pass, X, XX, 1♣ … 7NT as plain text */
export const callText = (call: Call) => (isBid(call) ? `${levelOf(call)}${STRAIN_SYMBOLS[strainOf(call)]}` : call === 'P' ? 'Pass' : call)
