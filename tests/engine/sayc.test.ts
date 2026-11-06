import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evalBoards } from '../../eval/deals.ts'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import type { Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, turnOf } from '../../shared/game.ts'
import { parsePracticeSettings } from '../../shared/practice.ts'
import { defaultRobotKind, isRobotKind, OPEN_ROBOT_KINDS, ROBOT_KINDS, robotId, robotKindOf, robotKindsFor } from '../../shared/protocol.ts'
import { ROBOT_SYSTEMS } from '../../shared/robot/robots.ts'
import { deriveCard } from '../../shared/robot/system/card.ts'
import { patternProblem } from '../../shared/robot/system/context.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { SAYC } from '../../shared/robot/system/sayc/index.ts'
import type { Spec } from '../../shared/robot/system/spec.ts'
import { HEAVY_MS } from './heavy.ts'

/** SAYC (docs/systems/sayc.md, e5-t51): what a hand bids and what a call is explained as, section by section */

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  const cards = text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
  if (cards.length !== 13) throw new Error(`${text} has ${cards.length} cards`)
  return cards
}

function auctionOf(calls: string, dealer: Seat): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

function bidOver(cards: string, calls = '', vul: Vulnerability = 'None') {
  const auction = auctionOf(calls, 'N')
  return choose(SAYC, hand(cards), nextSeat('N', auction.length), auction, 'N', vul).call
}

/** What `call` shows after these calls, on its own (without what the caller had already shown) */
function shows(calls: string, call: string, vul: Vulnerability = 'None'): Spec {
  const spec = explain(SAYC, auctionOf(calls, 'N'), 'N', vul, false).get(call)
  if (!spec) throw new Error(`nothing explains ${call} after '${calls}'`)
  return spec
}

describe('the book patterns', () => {
  it('are all well formed', () => {
    for (const book of SAYC.books)
      for (const pattern of book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after) expect(patternProblem(pattern)).toBeNull()
  })

  it('never read the club’s system', () => {
    const dir = 'shared/robot/system/sayc'
    for (const file of readdirSync(dir)) expect(readFileSync(`${dir}/${file}`, 'utf8'), file).not.toMatch(/tku\//)
    expect(readFileSync('shared/robot/system/open-systems.ts', 'utf8')).not.toMatch(/from '.*tku/)
  })
})

describe('openings (§1)', () => {
  it.each([
    ['AKQ32 K32 Q32 32', '1S', 'a five-card major'],
    ['AQJ32 KQJ32 32 2', '1S', 'the higher of 5-5'],
    ['K32 Q3 AQ32 K432', '1D', '4-4 in the minors'],
    ['AK32 Q32 Q32 K32', '1C', '3-3 in the minors'],
    ['AK32 Q432 K32 32', '1D', '4-4-3-2 with three diamonds'],
    ['AKJ32 K32 KJ2 Q2', '1N', 'a five-card major in 1NT, even with 17'],
    ['KJ2 Q2 AKJ32 K32', '1N', 'a five-card minor in 1NT'],
    ['AK32 KQ2 AQ2 K32', '2N', '20–21'],
    ['AKQ2 AKQ2 KQ2 K2', '3N', '25–27'],
    ['AKQJ2 AKQ2 AK2 2', '2C', 'strong'],
    ['KQJ532 32 432 32', '2S', 'a weak two'],
    ['32 QT9532 K32 K2', '2H', 'a weak two'],
    ['32 32 AQ9532 432', '2D', 'a weak two in diamonds'],
    ['32 Q32 K32 Q5432', 'P', 'too little'],
  ])('%s opens %s (%s)', (cards, call) => {
    expect(bidOver(cards)).toBe(call)
  })

  it('reads the booklet’s ranges off the rules', () => {
    expect(shows('', '1N')).toEqual({ hcp: [15, 17], balanced: true })
    expect(shows('', '2N')).toEqual({ hcp: [20, 21], balanced: true })
    expect(shows('', '3N')).toEqual({ hcp: [25, 27], balanced: true })
    expect(shows('', '2S').hcp).toEqual([5, 11])
    expect(shows('', '1S').len?.S).toEqual([5, 13])
    expect(shows('', '1D').len?.D).toEqual([3, 13])
  })

  it('counts tricks for a preempt: two short vulnerable against not, three at equal, four at favourable', () => {
    const seven = 'KQT5432 2 432 32'
    expect(bidOver(seven, '', 'None')).toBe('3S')
    expect(bidOver(seven, '', 'Both')).toBe('3S')
    expect(bidOver(seven, '', 'NS')).toBe('2S')
    const poor = 'KJ95432 Q 432 32'
    expect(bidOver(poor, '', 'EW')).toBe('3S')
    expect(bidOver(poor, '', 'None')).toBe('2S')
  })

  it('does not preempt in fourth seat', () => {
    expect(bidOver('KQJ532 32 432 32', 'P P P')).toBe('P')
  })
})

describe('after 1♥ or 1♠ (§2)', () => {
  it.each([
    ['KQ32 32 K432 432', '1H P', '1S', 'four spades'],
    ['K32 32 Q432 J432', '1H P', '1N', '6–9'],
    ['Q2 32 K32 AKJ432', '1H P', '2C', 'a new suit at the two level'],
    ['32 KQ432 K32 Q32', '1S P', '2H', 'five hearts over spades'],
    ['K32 K32 Q432 432', '1S P', '2S', 'a single raise'],
    ['KJ2 K32 K432 432', '1S P', '3S', 'a limit raise'],
    ['KJ32 K32 AQ32 32', '1S P', '2N', 'Jacoby'],
    ['K2 AQ2 KJ32 Q432', '1S P', '3N', '15–17 with two'],
    ['KJ932 2 Q432 432', '1S P', '4S', 'a preemptive raise'],
    ['AKQ32 2 AQ32 K32', '1H P', '2S', 'a strong jump shift'],
  ])('%s after %s bids %s (%s)', (cards, calls, call) => {
    expect(bidOver(cards, calls)).toBe(call)
  })

  it('a two-level new suit forces one round, not to game', () => {
    expect(shows('1S P', '2C').forcing).toBe('oneRound')
    expect(shows('1S P', '2H').forcing).toBe('oneRound')
    expect(shows('1S P', '2C').hcp).toEqual([10, 40])
    expect(shows('1S P', '2H').len?.H).toEqual([5, 13])
  })

  it('1NT does not force, and shows 6–9', () => {
    expect(shows('1S P', '1N')).toEqual({ hcp: [6, 9] })
  })

  it('opener may pass 1NT, and bids on by strength', () => {
    expect(bidOver('AQ432 K32 K32 32', '1S P 1N P')).toBe('P')
    expect(shows('1H P 1N P', '2S').name).toBe('reverse')
    expect(shows('1S P 1N P', '3S').hcp).toEqual([16, 18])
  })

  it('opener’s rebids sit in the booklet’s ladder', () => {
    expect(shows('1D P 1S P', '2S').hcp).toEqual([11, 15])
    expect(shows('1D P 1S P', '3S').hcp).toEqual([16, 18])
    expect(shows('1D P 1S P', '4S').hcp).toEqual([19, 21])
    expect(shows('1D P 1H P', '1S').hcp).toEqual([11, 18])
    expect(shows('1D P 1S P', '2H').name).toBe('reverse')
    expect(shows('1D P 1S P', '3C').forcing).toBe('game')
    expect(bidOver('AK2 32 KJ32 Q432', '1D P 1H P')).toBe('1N')
    expect(bidOver('32 AQ32 AKJ32 K2', '1D P 1S P')).toBe('2H')
  })

  it('answers Jacoby 2NT as written', () => {
    expect(shows('1S P', '2N').name).toBe('jacoby2N')
    expect(shows('1S P 2N P', '3D').notes).toEqual([{ key: 'shortIn', strain: 'D' }])
    expect(shows('1S P 2N P', '4S').hcp).toEqual([11, 14])
    expect(shows('1S P 2N P', '3N').hcp).toEqual([15, 17])
    expect(shows('1S P 2N P', '3S').hcp).toEqual([18, 21])
    expect(shows('1S P 2N P', '4C').len?.C).toEqual([5, 13])
  })

  it('after opener’s 1NT a lower new suit does not force, and there is no new minor forcing', () => {
    const twoClubs = shows('1D P 1H P 1N P', '2C')
    expect(twoClubs.forcing).toBeUndefined()
    expect(twoClubs.name).toBeUndefined()
    expect(shows('1D P 1H P 1N P', '2S').forcing).toBe('game')
    expect(shows('1D P 1H P 1N P', '3C').forcing).toBe('game')
    expect(shows('1D P 1H P 1N P', '2N').notes).toEqual([{ key: 'invite' }])
  })

  it('the fourth suit forces one round and may be artificial', () => {
    const fourth = shows('1C P 1H P 1S P', '2D')
    expect(fourth.name).toBe('fourthSuit')
    expect(fourth.forcing).toBe('oneRound')
  })

  it('after a two-level response opener’s rebid forces, and three of opener’s suit by a jump forces to game', () => {
    expect(shows('1S P 2C P', '2D').forcing).toBe('oneRound')
    expect(shows('1S P 2C P 2D P', '2S').notes).toEqual([{ key: 'preference', strain: 'S' }])
    expect(shows('1S P 2C P 2D P', '2S').len?.S).toEqual([2, 2])
    expect(shows('1S P 2C P 2D P', '3S').forcing).toBe('game')
    expect(shows('1S P 2C P 2D P', '2N').notes).toEqual([{ key: 'invite' }])
    expect(shows('1S P 2C P 2D P', '2H').forcing).toBe('game')
  })

  it('a passed hand’s new suit does not force', () => {
    expect(shows('P P 1S P', '2C').forcing).toBeUndefined()
    expect(explain(SAYC, auctionOf('P P 1S P', 'N'), 'N', 'None', false).get('2N')?.name).not.toBe('jacoby2N')
  })
})

describe('after 1♣ or 1♦ (§3)', () => {
  it.each([
    ['K32 Q432 K432 32', '1C P', '1D', 'up the line'],
    ['K32 Q432 K32 Q32', '1C P', '1H', 'a major'],
    ['Q32 32 K32 K5432', '1C P', '2C', 'a raise: five clubs'],
    ['Q32 32 K432 K432', '1D P', '2D', 'a raise: four diamonds'],
    ['K32 Q32 KQ3 K432', '1C P', '2N', '13–15'],
    ['K32 Q32 AQ3 KQ43', '1C P', '3N', '16–18'],
    ['K32 32 Q32 AJ432', '1D P', '2C', 'a new suit at the two level'],
  ])('%s after %s bids %s (%s)', (cards, calls, call) => {
    expect(bidOver(cards, calls)).toBe(call)
  })

  it('has no inverted minors: a single raise is weak and does not force', () => {
    const raise = shows('1C P', '2C')
    expect(raise.name).toBeUndefined()
    expect(raise.forcing).toBeUndefined()
    expect(raise.tp).toEqual([6, 10])
    expect(raise.len?.C).toEqual([5, 13])
    expect(shows('1D P', '2D').len?.D).toEqual([4, 13])
  })

  it('2NT forces to game, 3NT is 16–18', () => {
    expect(shows('1D P', '2N').forcing).toBe('game')
    expect(shows('1D P', '2N').hcp).toEqual([13, 15])
    expect(shows('1D P', '3N').hcp).toEqual([16, 18])
  })
})

describe('after 1NT (§4)', () => {
  it.each([
    ['KQ32 K32 Q432 32', '1N P', '2C', 'Stayman with four spades'],
    ['K5432 Q2 Q432 32', '1N P', '2H', 'a transfer'],
    ['32 Q5432 Q432 32', '1N P', '2D', 'a transfer'],
    ['32 32 Q32 Q95432', '1N P', '2S', 'a club bust'],
    ['32 32 K32 KQ9532', '1N P', '3C', 'an invitation'],
    ['AQ5432 K2 A32 Q2', '1N P', '3S', 'six spades and slam interest'],
    ['A32 K32 KQ32 A32', '1N P', '4N', 'quantitative'],
    ['K32 Q32 Q432 Q32', '1N P', '2N', 'an invitation without a major'],
    ['K32 Q32 AQ32 K32', '1N P', '3N', 'to play'],
    ['532 862 Q432 432', '1N P', 'P', 'nothing'],
  ])('%s after %s bids %s (%s)', (cards, calls, call) => {
    expect(bidOver(cards, calls)).toBe(call)
  })

  it('opener answers Stayman with hearts first and accepts a transfer, jumping with 17 and four', () => {
    expect(bidOver('AQ32 KQ32 K32 Q2', '1N P 2C P')).toBe('2H')
    expect(bidOver('AQ32 Q32 K32 KQ2', '1N P 2C P')).toBe('2S')
    expect(bidOver('AQ3 Q32 K32 KQ32', '1N P 2C P')).toBe('2D')
    expect(bidOver('AKQ2 Q32 K32 K32', '1N P 2H P')).toBe('3S')
    expect(bidOver('AQ2 Q32 K32 KQ32', '1N P 2H P')).toBe('2S')
  })

  it('Stayman does not force past the answer: a weak hand may stop', () => {
    expect(bidOver('Q532 J532 Q532 2', '1N P')).toBe('2C')
    expect(bidOver('Q532 J532 Q532 2', '1N P 2C P 2D P')).toBe('P')
    expect(shows('1N P 2C P 2D P', '3C').notes).toEqual([{ key: 'slamInterest' }])
  })

  it('after the transfer: pass, invite, a natural game force, a choice, or to play', () => {
    const after = '1N P 2H P 2S P'
    expect(bidOver('K5432 32 Q432 32', after)).toBe('P')
    expect(shows(after, '2N').notes).toEqual([{ key: 'invite' }])
    expect(shows(after, '3S').notes).toEqual([{ key: 'invite' }])
    expect(shows(after, '3C').forcing).toBe('game')
    expect(shows(after, '3H').forcing).toBe('game')
    expect(shows(after, '3N').notes).toEqual([{ key: 'choiceOf', calls: ['4S', '3N'] }])
    expect(shows(after, '4S').notes).toEqual([{ key: 'toPlay' }])
    expect(bidOver('A2 KQ2 KJ32 Q432', `${after} 2N P`)).toBe('P')
    expect(bidOver('A2 KQ2 K432 KQ32', `${after} 2N P`)).toBe('3N')
    expect(bidOver('AQ2 Q32 K32 KQ32', `${after} 2N P`)).toBe('4S')
  })

  it('2♠ asks for 3♣: pass with clubs, 3♦ with diamonds, which opener passes', () => {
    expect(bidOver('AQ2 Q32 K32 KQ32', '1N P 2S P')).toBe('3C')
    expect(bidOver('32 32 Q32 Q95432', '1N P 2S P 3C P')).toBe('P')
    expect(bidOver('32 32 Q95432 Q32', '1N P 2S P 3C P')).toBe('3D')
    expect(bidOver('AQ2 Q32 K32 KQ32', '1N P 2S P 3C P 3D P')).toBe('P')
  })

  it('4♣ is Gerber over any 1NT or 2NT, rebids included', () => {
    expect(shows('1N P', '4C').name).toBe('gerber')
    expect(shows('2N P', '4C').name).toBe('gerber')
    expect(shows('1D P 1H P 1N P', '4C').name).toBe('gerber')
    expect(shows('1D P 1H P 2N P', '4C').name).toBe('gerber')
  })

  it('over a double everything stays on; over a bid it is natural and their suit is Stayman', () => {
    expect(shows('1N X', '2C').name).toBe('stayman')
    expect(shows('1N X', '2D').name).toBe('transfer')
    expect(shows('1N 2S', '3S').name).toBe('stayman')
    expect(shows('1N 2S', '3S').forcing).toBe('game')
    expect(shows('1N 2C', '2D').name).toBeUndefined()
    expect(shows('1N 2C', '2D').len?.D).toEqual([5, 13])
    expect(shows('1N 2D', '2H').name).toBeUndefined()
    expect(shows('1N 2S', 'X').name).toBe('penalty')
  })

  it('over a doubled response a bid shows a real fit; redouble is to play', () => {
    expect(bidOver('AK2 Q32 AK32 J32', '1N P 2D X')).toBe('2H')
    expect(bidOver('AK32 Q2 AK32 J32', '1N P 2D X')).toBe('P')
    expect(shows('1N P 2D X', 'XX').notes).toEqual([{ key: 'toPlay' }])
  })
})

describe('after 2NT and 3NT (§5)', () => {
  it('2NT has Stayman, transfers, Gerber and a slam invitation', () => {
    expect(shows('2N P', '3C').name).toBe('stayman')
    expect(shows('2N P', '3D').notes).toEqual([{ key: 'transferTo', strain: 'H' }])
    expect(shows('2N P', '3H').notes).toEqual([{ key: 'transferTo', strain: 'S' }])
    expect(shows('2N P', '4N').name).toBe('quantitative')
  })

  it('3NT has them a level higher', () => {
    expect(shows('3N P', '4C').name).toBe('stayman')
    expect(shows('3N P', '4D').notes).toEqual([{ key: 'transferTo', strain: 'H' }])
    expect(shows('3N P', '4H').notes).toEqual([{ key: 'transferTo', strain: 'S' }])
  })
})

describe('after 2♣ and weak twos (§6, §7)', () => {
  it('2♣: 2♦ waits, a positive is five cards and 8, 2NT is a balanced 8', () => {
    expect(shows('2C P', '2D').name).toBe('waiting')
    expect(shows('2C P', '2H')).toEqual({ len: { H: [5, 13] }, hcp: [8, 40], forcing: 'game' })
    expect(shows('2C P', '2N').hcp).toEqual([8, 8])
    expect(bidOver('32 KQJ32 Q32 432', '2C P')).toBe('2H')
    expect(bidOver('K32 Q32 Q432 J32', '2C P')).toBe('2N')
    expect(bidOver('K32 K32 Q432 J32', '2C P')).toBe('2D')
  })

  it('a double cancels the convention: 2♦ is natural and positive', () => {
    expect(shows('2C X', '2D').len?.D).toEqual([5, 13])
    expect(shows('2C X', '2D').name).toBeUndefined()
  })

  it('opener’s 2NT is 22–24 and takes the 2NT responses; a suit rebid forces up to three of a major', () => {
    expect(shows('2C P 2D P', '2N').hcp).toEqual([22, 24])
    expect(shows('2C P 2D P 2N P', '3C').name).toBe('stayman')
    expect(shows('2C P 2D P', '2H').forcing).toBe('oneRound')
    expect(shows('2C P 2D P 2H P 2S P', '3H').forcing).toBeUndefined()
  })

  it('a weak two: 2NT forces, raises and 3NT are to play, a new suit forces one round', () => {
    expect(shows('2S P', '2N').forcing).toBe('oneRound')
    expect(shows('2S P', '3S').notes).toEqual([{ key: 'toPlay' }])
    expect(shows('2S P', '3N').notes).toEqual([{ key: 'toPlay' }])
    expect(shows('2S P', '3H').forcing).toBe('oneRound')
    expect(shows('2S X', '2N').forcing).toBe('oneRound')
    expect(shows('2S 3C', '3N').notes).toEqual([{ key: 'toPlay' }])
  })

  it('opener answers 2NT: a minimum rebids, a maximum shows a feature or bids 3NT', () => {
    expect(bidOver('KQJ532 32 Q32 32', '2S P 2N P')).toBe('3S')
    expect(bidOver('KQJ532 K2 Q32 32', '2S P 2N P')).toBe('3H')
    expect(bidOver('KQJ532 Q2 Q32 Q2', '2S P 2N P')).toBe('3N')
  })
})

describe('competition: their opening (§8)', () => {
  it.each([
    ['KQ532 32 K32 432', '1D', '1S', 'an overcall'],
    ['AQ2 KJ2 K32 Q432', '1S', '1N', '15–18 with a stopper'],
    ['KQJ532 32 432 32', '1D', '2S', 'a weak jump'],
    ['32 KQJ5432 32 32', '1S', '3H', 'like opening three'],
    ['2 32 KQ532 KQ532', '1S', '2N', 'the two lowest'],
    ['KQ532 KQ532 32 2', '1C', '2C', 'Michaels: the majors'],
    ['2 KQ532 32 KQ532', '1S', '2S', 'Michaels: hearts and a minor'],
    ['AQ32 KJ32 2 Q432', '1D', 'X', 'takeout'],
  ])('%s over %s bids %s (%s)', (cards, calls, call) => {
    expect(bidOver(cards, calls)).toBe(call)
  })

  it('names the conventions as written', () => {
    expect(shows('1S', '2C')).toMatchObject({ name: 'overcall', hcp: [8, 16] })
    expect(shows('1S', '1N')).toMatchObject({ hcp: [15, 18], balanced: true })
    expect(shows('1D', '2S').name).toBe('weakJumpOvercall')
    expect(shows('1C', '2C')).toMatchObject({ name: 'michaels', hcp: [8, 40] })
    expect(shows('1S', '2S')).toMatchObject({ name: 'michaels', hcp: [10, 40] })
    expect(shows('1S', '2N').name).toBe('unusual2N')
  })

  it('advancing an overcall: only their suit forces, and it asks about the overcall', () => {
    expect(shows('1H 1S P', '2H').forcing).toBe('oneRound')
    expect(shows('1H 1S P', '2D').forcing).toBeUndefined()
    expect(shows('1H 1S P 2H P', '2S').notes).toEqual([{ key: 'minimum' }])
  })

  it('Michaels over a major: 2NT asks for the minor', () => {
    expect(shows('1S 2S P', '2N').name).toBe('relay')
    expect(bidOver('2 KQ532 32 KQ532', '1S 2S P 2N P')).toBe('3C')
    expect(bidOver('2 KQ532 KQ532 32', '1S 2S P 2N P')).toBe('3D')
  })

  it('reopening: 1NT is 10–15', () => {
    expect(shows('1H P P', '1N').hcp).toEqual([10, 15])
  })

  it('a double is for takeout through 4♦, for penalty above; a preempt’s cue is Michaels', () => {
    expect(shows('2H', 'X').name).toBe('takeout')
    expect(shows('3C', 'X').name).toBe('takeout')
    expect(shows('4D', 'X').name).toBe('takeout')
    expect(shows('4H', 'X').name).toBe('penalty')
    expect(shows('5C', 'X').name).toBe('penalty')
    expect(shows('2H', '3H').name).toBe('michaels')
    expect(shows('3C', '4C').name).toBe('michaels')
  })

  it('over two suits a bid in either is natural', () => {
    expect(shows('1H P 1S', '2H').name).toBeUndefined()
    expect(shows('1H P 1S', '2S').len?.S).toEqual([6, 13])
  })

  it('over 1NT nothing is conventional but 2NT', () => {
    expect(shows('1N', 'X').name).toBe('penalty')
    expect(shows('1N', '2C').name).toBe('overcall')
    expect(shows('1N', '2C').len?.C).toEqual([5, 13])
    expect(shows('1N', '2N').len?.D).toEqual([5, 13])
  })

  it('a jump after a takeout double invites, and their suit forces', () => {
    expect(shows('1D X P', '2S').notes).toEqual([{ key: 'invite' }])
    expect(shows('1D X P', '2D').forcing).toBe('oneRound')
  })
})

describe('competition: our opening (§9)', () => {
  it('negative doubles go through 2♠, with the booklet’s lengths', () => {
    expect(shows('1C 1D', 'X')).toMatchObject({ name: 'negative', len: { S: [4, 13], H: [4, 13] } })
    expect(shows('1D 1H', 'X').len?.S).toEqual([4, 4])
    expect(shows('1D 1S', 'X').len?.H).toEqual([4, 13])
    expect(shows('1D 2S', 'X').name).toBe('negative')
    expect(shows('1D 3C', 'X').name).toBe('penalty')
  })

  it('1♠ over 1♥ promises five; two of a major promises five and 11', () => {
    expect(shows('1D 1H', '1S').len?.S).toEqual([5, 13])
    expect(shows('1D 1S', '2H')).toMatchObject({ len: { H: [5, 13] }, hcp: [11, 40] })
  })

  it('their suit forces to game; 2NT over a suit overcall is natural', () => {
    expect(shows('1S 2C', '3C')).toMatchObject({ name: 'cueRaise', forcing: 'game' })
    expect(shows('1H 2C', '2N').name).toBeUndefined()
    expect(shows('1H 2C', '2N').hcp).toEqual([12, 14])
  })

  it('over a takeout double: one-level suits force, 2NT raises, a jump shift is to play, the jump raise preempts', () => {
    expect(shows('1S X', '2N').name).toBe('truscott')
    expect(shows('1H X', '1S').forcing).toBe('oneRound')
    expect(shows('1S X', '2C').forcing).toBeUndefined()
    expect(shows('1S X', '2C').hcp).toEqual([6, 10])
    expect(shows('1S X', 'XX').hcp).toEqual([10, 40])
    expect(shows('1S X', '3S').name).toBe('preemptiveRaise')
    expect(shows('1S X', '3C').name).toBe('weakJumpShift')
  })

  it('over their convention: a double shows 10+, one of their suits forces to game', () => {
    expect(shows('1H 2N', 'X').hcp).toEqual([10, 40])
    expect(shows('1H 2N', '3C').forcing).toBe('game')
    expect(shows('1H 2H', '2S').forcing).toBe('game')
    expect(shows('1H 2H', 'X').hcp).toEqual([10, 40])
  })

  it('a redouble: SOS low down, to play at the four level', () => {
    expect(bidOver('32 2 QJ32 Q86432', '1H P P X P P')).toBe('XX')
    expect(shows('1H P P X P P', 'XX').name).toBe('sos')
    expect(shows('4S X', 'XX').notes).toEqual([{ key: 'toPlay' }])
  })
})

describe('slam (§10)', () => {
  it('4NT asks for aces, not keycards; 5NT for kings', () => {
    expect(shows('1S P 2N P 3S P', '4N').name).toBe('blackwood')
    expect(bidOver('KQJ32 KQ2 Q32 K2', '1S P 2N P 3S P 4N P')).toBe('5C')
    expect(bidOver('AKQ32 KQ2 A32 32', '1S P 2N P 3S P 4N P')).toBe('5H')
    expect(shows('1S P 2N P 3S P 4N P', '5D').notes).toEqual([{ key: 'aces', counts: [1] }])
    expect(shows('1S P 2N P 3S P 4N P', '5C').notes).toEqual([{ key: 'aces', counts: [0, 4] }])
  })

  it('answers the king ask by steps', () => {
    const after = '1S P 2N P 3S P 4N P 5D P 5N P'
    expect(shows(after, '6C').notes).toEqual([{ key: 'kings', counts: [0, 4] }])
    expect(shows(after, '6H').notes).toEqual([{ key: 'kings', counts: [2] }])
  })

  it('a jump to 5NT is the grand slam force', () => {
    expect(shows('1S P 2N P 3S P', '5N').name).toBe('grandSlamForce')
    expect(bidOver('AKJ32 Q32 K32 32', '1S P 2N P 3S P 5N P')).toBe('7S')
    expect(bidOver('AJ532 Q32 K32 K2', '1S P 2N P 3S P 5N P')).toBe('6S')
  })

  it('Gerber: answers by steps, 5♣ asks for kings', () => {
    expect(bidOver('AQ2 KQ2 AK32 Q32', '1N P 4C P')).toBe('4S')
    expect(bidOver('KQ2 KQ2 KQ32 K32', '1N P 4C P')).toBe('4D')
    expect(shows('1N P 4C P 4S P', '5C').name).toBe('kingAsk')
    expect(shows('1N P 4C P 4S P 5C P', '5D').notes).toEqual([{ key: 'kings', counts: [0, 4] }])
  })

  it('a bid by an opponent cancels the convention', () => {
    expect(explain(SAYC, auctionOf('1S P 2N P 3S P 4N 5C', 'N'), 'N', 'None', false).get('5D')?.notes?.some((n) => n.key === 'aces')).toBeFalsy()
  })
})

describe('whole deals', () => {
  /** Conventions the card does not have: none of these may come out of a SAYC robot */
  const NOT_SAYC = new Set(['smolen', 'texas', 'minorStayman', 'invertedMinor', 'drury', 'soloway', 'fitJump', 'newMinorForcing', 'rkcb', 'rkcb1430', 'keycards', 'dopi', 'support', 'responsive', 'cappelletti', 'sandwich', 'lebensohl', 'shortSuitTry', 'askShortness', 'splinter', 'unusualVsUnusual'])

  it('300 deals: four SAYC robots bid legally to the end, explaining every call but pass in SAYC’s own terms', { timeout: HEAVY_MS }, () => {
    const contracts = new Map<string, number>()
    for (const board of evalBoards(300)) {
      let state = newBoard(board.boardNo, board.hands)
      while (state.phase === 'auction') {
        const seat = turnOf(state)!
        const { call, shows: spec } = choose(SAYC, state.hands[seat], seat, state.auction, state.dealer, state.vul)
        if (call !== 'P') expect(spec && words(spec, 'zh'), `board ${board.boardNo}: ${call}`).toBeTruthy()
        if (spec?.name) expect(NOT_SAYC.has(spec.name), `${spec.name} on board ${board.boardNo}`).toBe(false)
        // makeCall throws on an illegal call
        state = makeCall(state, seat, call, spec ? words(spec, 'zh') : undefined)
        expect(state.auction.length, `board ${board.boardNo}`).toBeLessThan(40)
      }
      const c = contractOf(state.auction)
      const kind = !c ? 'passed' : c.level >= 6 ? 'slam' : c.level >= (c.strain === 'N' ? 3 : c.strain === 'S' || c.strain === 'H' ? 4 : 5) ? 'game' : 'part'
      contracts.set(kind, (contracts.get(kind) ?? 0) + 1)
    }
    expect(contracts.get('passed') ?? 0).toBeLessThan(30)
    expect(contracts.get('game') ?? 0).toBeGreaterThan(90)
    expect(contracts.get('slam') ?? 0).toBeLessThan(20)
  })

  it('has a readable card with every section', () => {
    const card = deriveCard(SAYC)
    expect(card.system).toBe('sayc')
    for (const section of card.sections) expect(section.groups.length, section.id).toBeGreaterThan(0)
    expect(JSON.stringify(card)).not.toContain('nameZh')
    const conventions = card.sections.flatMap((s) => s.groups.flatMap((g) => g.calls.map((c) => c.shows.name)))
    expect(conventions).toContain('stayman')
    expect(conventions).toContain('blackwood')
    expect(conventions).toContain('negative')
    expect(conventions).toContain('michaels')
    expect(conventions).not.toContain('invertedMinor')
    expect(conventions).not.toContain('rkcb')
  })
})

describe('a new system on the old stored values', () => {
  it('is known everywhere the kinds are listed', () => {
    expect(Object.keys(ROBOT_SYSTEMS).sort()).toEqual([...ROBOT_KINDS].sort())
    expect(OPEN_ROBOT_KINDS).toContain('sayc')
    expect(OPEN_ROBOT_KINDS).not.toContain('tku')
    expect(isRobotKind('sayc')).toBe(true)
  })

  it('keeps the ids and defaults that were saved before', () => {
    expect(robotKindOf('robot:N')).toBe('tku')
    expect(robotKindOf('robot:gib:beginner:N')).toBe('gib')
    expect(robotKindOf('robot:gib:N')).toBe('gib')
    expect(robotKindOf(robotId('sayc', 'N'))).toBe('sayc')
    expect(defaultRobotKind(null)).toBe('gib')
    expect(defaultRobotKind({ permissions: ['tkuSystem'] })).toBe('tku')
  })

  it('offers each member the public systems, and the club’s only with the permission', () => {
    expect(robotKindsFor(null)).toEqual(['gib', 'sayc'])
    expect(robotKindsFor({ permissions: ['tkuSystem'] })).toEqual(['tku', 'gib', 'sayc'])
    expect(parsePracticeSettings({ robotKind: 'sayc' })).toMatchObject({ settings: { robotKind: 'sayc' } })
    expect(parsePracticeSettings({ robotKind: 'nope' })).toEqual({ field: 'robotKind' })
  })
})
