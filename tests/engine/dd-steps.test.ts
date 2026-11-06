// @vitest-environment node
import { Dds, loadDds } from 'bridge-dds'
import { beforeAll, describe, expect, it } from 'vitest'
import { evalBoards } from '../../eval/deals.ts'
import { sideOf, type Card, type Hands, type Seat, type Suit } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, remainingCards, turnOf, type BoardState } from '../../shared/game.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { canTake } from '../../shared/robot/dd.ts'
import { solveDeal, solvePosition } from '../../src/lib/ddsSolve.ts'
import { biggestLosses, boardKey, forcedStep, hasSteps, positionBefore, solvedStep, stepTotals, type DdStep, type SolvedStep } from '../../src/lib/ddSteps.ts'
import { cardScores, ddPosition, ddRequest, toAnalysis, type DdPositionRequest, type DdTable } from '../../src/lib/doubleDummy.ts'

/**
 * The trick counts themselves (`e4-t35`, `e10-t12`), with the real DDS in WASM: hand-checked textbook
 * positions, and on boards TKB played out, what must hold if the numbers are right. Any wrong count
 * of tricks breaks one of them.
 */

let dds: Dds
beforeAll(async () => {
  dds = new Dds(await loadDds())
})

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
const hand = (text: string): Card[] => text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))

/** A position from four PBN hands, for positions with fewer than 13 cards */
const position = (trump: number, first: Seat, remainCards: string, trickSuit = [0, 0, 0], trickRank = [0, 0, 0]): DdPositionRequest => ({
  trump,
  first: ['N', 'E', 'S', 'W'].indexOf(first),
  currentTrickSuit: trickSuit,
  currentTrickRank: trickRank,
  remainCards,
})

const scoresOf = (request: DdPositionRequest) => cardScores(solvePosition(dds, request))
const NOTRUMP = 4

describe('hand-checked positions', () => {
  it('a positional squeeze: South’s ♣A squeezes West for all four tricks', () => {
    // North ♠AJ ♥AJ, South ♣A ♠2 ♥2 ♦2, West ♠KQ ♥KQ, East ♦6543. West discards before North, who
    // keeps the jack of the suit West lets go. Any other lead loses the ending
    const scores = scoresOf(position(NOTRUMP, 'S', 'N:AJ.AJ.. ..6543. 2.2.2.A KQ.KQ..'))
    expect(scores.get('CA')).toBe(4)
    expect(Math.max(...scores.values())).toBe(4)
    expect(scores.get('D2')).toBeLessThan(4)
  })

  it('the same cards with the guards in East: North discards first, so no squeeze and three tricks', () => {
    const scores = scoresOf(position(NOTRUMP, 'S', 'N:AJ.AJ.. KQ.KQ.. 2.2.2.A ..6543.'))
    expect(scores.get('CA')).toBe(3)
    expect(Math.max(...scores.values())).toBe(3)
  })

  it('a finesse: with the king in front of the ace-queen, two tricks led from South, one with the king behind', () => {
    expect(scoresOf(position(NOTRUMP, 'S', 'N:AQ... 65... 32... K4...')).get('S3')).toBe(2)
    expect(scoresOf(position(NOTRUMP, 'S', 'N:AQ... K4... 32... 65...')).get('S3')).toBe(1)
    // North on lead has no finesse: the ace, then the queen into the king
    expect(scoresOf(position(NOTRUMP, 'N', 'N:AQ... 65... 32... K4...')).get('SA')).toBe(1)
  })

  it('a ruff: in hearts the trump takes the ace, in no trump it does not', () => {
    const cards = 'N:.2.K. ..Q.3 .3..2 A...4'
    expect(scoresOf(position(NOTRUMP, 'W', cards)).get('SA')).toBe(2)
    // In hearts North ruffs the ace, and his ♦K beats East's queen
    expect(scoresOf(position(1, 'W', cards)).get('SA')).toBe(0)
  })

  it('counts the trick being played: West’s ♠5 beats the ♠4 on the table, and his ace is still to come', () => {
    const scores = scoresOf(position(NOTRUMP, 'N', 'N:.A.. .2.. .3.. A5...', [0, 0, 0], [2, 3, 4]))
    expect(scores.get('S5')).toBe(2)
    expect(scores.get('SA')).toBe(2)
  })
})

/**
 * 7♦ by South, West on lead, worked out by hand. South's only loser is ♣K, and his ♠2 reaches North,
 * whose eleven other spades take the losers once trumps are drawn. Any club beats him: ♣A wins, and
 * under a low club East ruffs with ♦3 while South must follow with the king. Only West's ♦2 lets
 * him make, since it draws East's trump as well.
 */
const cashOrLose: Hands = {
  N: hand('AKQJT9876543 A - -'),
  E: hand('- KQJT98765432 3 -'),
  S: hand('2 - AKQJT987654 K'),
  W: hand('- - 2 AQJT98765432'),
}

/** Board 1, North deals, the calls given, passes after; the cards are then played with `choose` */
function played(hands: Hands, calls: string[], choose: (state: BoardState, seat: Seat) => Card): BoardState {
  let board: BoardState = newBoard(1, hands)
  for (const call of [...calls, 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  while (board.phase === 'play') {
    const seat = turnOf(board)!
    board = playCard(board, seat, choose(board, seat))
  }
  return board
}

const lowest = (state: BoardState, seat: Seat) => legalCards(state, seat).at(-1)!

function stepsOf(board: BoardState): DdStep[] {
  return board.play.map((_, index) => {
    const at = positionBefore(board, index)!
    return at.legal.length === 1 ? forcedStep(board, index) : solvedStep(board, index, at, cardScores(solvePosition(dds, at.request)))
  })
}

describe('the steps of a whole board, worked out by hand', () => {
  const CLUBS = hand('- - - AQJT98765432')

  it('West’s trump lead lost one trick, and every club was best', () => {
    const board = played(cashOrLose, ['P', 'P', '7D'], (state, seat) => (state.play.length ? lowest(state, seat) : 'D2'))
    const [lead] = stepsOf(board)
    expect(lead).toMatchObject({ status: 'solved', seat: 'W', card: 'D2', trick: 1, declarerSide: false, loss: 1, best: CLUBS })
    expect(biggestLosses([lead])).toEqual([lead])
  })

  it('a club lead, high or low, lost nothing', () => {
    for (const card of ['CA', 'C5']) {
      const board = played(cashOrLose, ['P', 'P', '7D'], (state, seat) => (state.play.length ? lowest(state, seat) : card))
      expect(stepsOf(board)[0]).toMatchObject({ card, loss: 0, best: CLUBS })
    }
  })

  it('South’s duck after a low club is forced, and East’s ruff is the only card that keeps the defence’s trick', () => {
    const board = played(cashOrLose, ['P', 'P', '7D'], (state, seat) => {
      if (state.play.length === 0) return 'C5'
      return state.play.length === 2 ? 'H2' : lowest(state, seat)
    })
    const steps = stepsOf(board)
    expect(steps[2]).toMatchObject({ seat: 'E', card: 'H2', loss: 1, best: ['D3'] })
    expect(steps[3]).toMatchObject({ seat: 'S', card: 'CK', loss: 0, best: ['CK'] })
  })

  it('declarer’s side is told apart from the defence, with the trick each card belongs to', () => {
    const board = played(cashOrLose, ['P', 'P', '7D'], (state, seat) => (state.play.length ? lowest(state, seat) : 'CA'))
    const steps = stepsOf(board)
    expect(steps.slice(0, 5).map((step) => [step.seat, step.trick, step.declarerSide])).toEqual([
      ['W', 1, false],
      ['N', 1, true],
      ['E', 1, false],
      ['S', 1, true],
      [board.play[4].seat, 2, sideOf(board.play[4].seat) === 'NS'],
    ])
  })

  it('puts the biggest loss first and adds up by side', () => {
    const at = (index: number, loss: number, declarerSide: boolean): SolvedStep => ({
      status: 'solved',
      index,
      seat: 'N',
      card: 'SA',
      trick: 1,
      declarerSide,
      best: [],
      loss,
    })
    const steps: (DdStep | undefined)[] = [at(0, 1, false), at(1, 0, true), undefined, at(3, 2, true), at(4, 1, true)]
    expect(biggestLosses(steps, 2).map((s) => s.index)).toEqual([3, 0])
    expect(stepTotals([...steps, { status: 'tooComplex', index: 5, seat: 'E', card: 'S2', trick: 2, declarerSide: false }])).toEqual({
      declarerLoss: 3,
      defenceLoss: 1,
      tooComplex: 1,
    })
  })

  it('has no number for a card DDS did not answer for', () => {
    const board = played(cashOrLose, ['P', 'P', '7D'], lowest)
    const at = positionBefore(board, 0)!
    expect(solvedStep(board, 0, at, new Map([['CA', 1]])).status).toBe('tooComplex')
  })

  it('tells boards apart by deal, contract and cards, and only takes finished whole deals', () => {
    const board = played(cashOrLose, ['P', 'P', '7D'], lowest)
    expect(hasSteps(board)).toBe(true)
    expect(hasSteps({ ...board, phase: 'play' })).toBe(false)
    expect(hasSteps({ ...board, contract: null })).toBe(false)
    expect(hasSteps({ ...board, hands: { ...board.hands, N: [] } })).toBe(false)
    const other = played(cashOrLose, ['P', 'P', '7D'], (state, seat) => legalCards(state, seat)[0])
    expect(boardKey(other)).not.toBe(boardKey(board))
    expect(boardKey({ ...board })).toBe(boardKey(board))
  })
})

describe('on boards TKB played out', () => {
  const boards: { board: BoardState; table: DdTable }[] = []
  beforeAll(async () => {
    for (const { boardNo, hands } of evalBoards(12)) {
      let state: BoardState = newBoard(boardNo, hands)
      while (state.phase === 'auction') {
        const seat = turnOf(state)!
        const { call, alert } = await ruleBrain.bid('gib', state, seat)
        state = makeCall(state, seat, call, alert)
      }
      while (state.phase === 'play') {
        const seat = turnOf(state)!
        state = playCard(state, seat, await ruleBrain.play('gib', state, seat))
      }
      if (hasSteps(state)) boards.push({ board: state, table: toAnalysis(solveDeal(dds, ddRequest(state.hands, state.dealer, state.vul))).table })
    }
  }, 120_000)

  it('the opening lead’s value is the DD table’s, from another call of DDS altogether', () => {
    expect(boards.length).toBeGreaterThan(8)
    for (const { board, table } of boards) {
      const { strain, declarer } = board.contract!
      // The hand on lead defends: what its side keeps at best leaves declarer the table's number
      const best = Math.max(...cardScores(solvePosition(dds, ddPosition(board, [])!.request)).values())
      expect(13 - best).toBe(table[strain][declarer])
    }
  }, 60_000)

  it('every trick given away is accounted for: DD result − declarer’s losses + the defence’s = tricks taken', () => {
    let withLosses = 0
    for (const { board, table } of boards) {
      const { strain, declarer } = board.contract!
      const steps = stepsOf(board)
      expect(steps.every((step) => step.status === 'solved')).toBe(true)
      const totals = stepTotals(steps)
      expect(table[strain][declarer] - totals.declarerLoss + totals.defenceLoss).toBe(board.result!.declarerTricks)
      if (totals.declarerLoss + totals.defenceLoss) withLosses++
    }
    // It would mean little if no card ever lost anything
    expect(withLosses).toBeGreaterThan(3)
  }, 60_000)

  it('agrees with the other solver (shared/robot/dd.ts) from six tricks left, at the start of a trick', () => {
    let compared = 0
    for (const { board } of boards) {
      const { strain } = board.contract!
      const at = 7 * 4
      const state: BoardState = { ...board, phase: 'play', play: board.play.slice(0, at), result: undefined }
      const seat = turnOf(state)!
      const best = Math.max(...cardScores(solvePosition(dds, positionBefore(board, at)!.request)).values())
      const hands = { N: remainingCards(state, 'N'), E: remainingCards(state, 'E'), S: remainingCards(state, 'S'), W: remainingCards(state, 'W') }
      const trump: Suit | null = strain === 'N' ? null : strain
      expect(canTake({ hands, trick: [], leader: seat, trump }, sideOf(seat), best)).toBe(true)
      expect(canTake({ hands, trick: [], leader: seat, trump }, sideOf(seat), best + 1)).toBe(false)
      compared++
    }
    expect(compared).toBeGreaterThan(8)
  }, 60_000)
})
