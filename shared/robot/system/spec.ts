import type { Call } from '../../auction.ts'
import type { Strain, Suit } from '../../cards.ts'
import type { Ctx } from './context.ts'
import type { Hand } from './evaluate.ts'

/**
 * A bidding system as data, the way GIB's bidding database works (docs/BBO GIB, ROBOT.md §6).
 * Every rule names the auctions it is for, the call it makes, what the hand needs (the criteria)
 * and what the call shows (the specification). The same rules choose a robot's call, explain any
 * call before it is made (the bidding box hints) and read what each player has shown.
 */

/** Inclusive range; a top of `ANY` means no upper limit */
export type Range = readonly [number, number]
export const ANY = 40

/** Suit quality, weakest first; GIB Bid Descriptions defines each one */
export const QUALITIES = ['biddable', 'rebiddable', 'twiceRebiddable', 'strongRebiddable', 'solid'] as const
export type Quality = (typeof QUALITIES)[number]

/** Stoppers, weakest first */
export const STOPS = ['partial', 'likely', 'stop', 'double'] as const
export type Stop = (typeof STOPS)[number]

/** How far a call forces partner: to bid once more, or on to game */
export type Forcing = 'oneRound' | 'game'

/** Conventions with a name of their own in the explanations (`describe.ts` has the words) */
export const CONVENTIONS = [
  'stayman',
  'smolen',
  'transfer',
  'superAccept',
  'texas',
  'minorStayman',
  'gerber',
  'quantitative',
  'jacoby2N',
  'splinter',
  'limitRaise',
  'preemptiveRaise',
  'invertedMinor',
  'shortSuitTry',
  'longSuitTry',
  'generalTry',
  'askShortness',
  'drury',
  'soloway',
  'fitJump',
  'newMinorForcing',
  'fourthSuit',
  'reverse',
  'strong2C',
  'waiting',
  'weakTwo',
  'featureAsk',
  'feature',
  'preempt',
  'overcall',
  'weakJumpOvercall',
  'takeout',
  'negative',
  'responsive',
  'support',
  'penalty',
  'michaels',
  'unusual2N',
  'cappelletti',
  'sandwich',
  'lebensohl',
  'truscott',
  'cueRaise',
  'unusualVsUnusual',
  'rkcb',
  'keycards',
  'queenAsk',
  'kingAsk',
  'dopi',
  'cue',
  'relay',
] as const
export type Convention = (typeof CONVENTIONS)[number]

/** Extra words a call may carry, with the strain or calls they mention */
export const NOTES = [
  'asksMajor',
  'noMajor',
  'noMinor',
  'transferTo',
  'completes',
  'relayTo',
  'choiceOf',
  'shortIn',
  'shortSomewhere',
  'noShortness',
  'asksShortness',
  'tryIn',
  'invite',
  'signoff',
  'toPlay',
  'slamTry',
  'slamInterest',
  'bothMajors',
  'bothMinors',
  'withMinor',
  'oneSuiter',
  'accept',
  'decline',
  'minimum',
  'maximum',
  'kingIn',
  'noKing',
  'void',
  'aces',
  'control',
  'game',
  'smallSlam',
  'grandSlam',
  'preference',
  'support',
] as const
export type NoteKey = (typeof NOTES)[number]

export interface Note {
  key: NoteKey
  strain?: Strain
  calls?: readonly Call[]
  count?: number
  /** Keycard answers: the counts the call stands for, e.g. [0, 3] */
  counts?: readonly number[]
}

/** What a hand has, or what a call shows about it */
export interface Spec {
  name?: Convention
  hcp?: Range
  /** GIB's total points: high cards plus short suits (`evaluate.ts`) */
  tp?: Range
  len?: Partial<Record<Suit, Range>>
  /** At least this quality */
  quality?: Partial<Record<Suit, Quality>>
  /** At least this stopper */
  stop?: Partial<Record<Suit, Stop>>
  /** true: 4333, 4432 or 5332; false: anything else */
  balanced?: boolean
  /** Aces 2, kings 1 */
  controls?: Range
  /** Keycards (four aces and the trump king) for `trump`, one of these counts */
  keycards?: readonly number[]
  trumpQueen?: boolean
  trump?: Suit
  forcing?: Forcing
  /** Asks or relays rather than names a strain */
  artificial?: boolean
  notes?: readonly Note[]
}

export type Dynamic<T> = T | ((ctx: Ctx) => T)

export interface Rule {
  /** The call, or how to work it out from the auction; null skips the rule */
  call: Dynamic<Call | null>
  /** What the call shows */
  shows?: Dynamic<Spec>
  /** What the hand must have; what the call shows by default */
  needs?: Dynamic<Spec>
  /** Anything else the hand must satisfy, given what the others have shown */
  when?: (hand: Hand, ctx: Ctx) => boolean
}

export interface Book {
  /**
   * The auctions this book is for, written from the opening bid on with our side's calls bare and
   * the opponents' in brackets: '1N (P)' is partner's 1NT and a pass on our right, '' is before
   * anyone has opened. `*` and `(*)` stand for any call, `(+)` for any call but pass.
   */
  after?: string | readonly string[]
  /** Any other condition on the auction */
  only?: (ctx: Ctx) => boolean
  rules: readonly Rule[]
  /**
   * Later books that also fit the auction add their rules for calls this book does not make (by
   * default this book is the last word)
   */
  more?: boolean
}

export type SystemId = 'gib'

export interface System {
  id: SystemId
  books: readonly Book[]
  /** The call to make when pass is not allowed and no rule fits the hand */
  emergency?: (hand: Hand, ctx: Ctx) => Call
}
