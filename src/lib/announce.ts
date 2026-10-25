import { ALL_PASS } from './calls.ts'
import { isBid, levelOf, strainOf, type Call, type Contract } from '../../shared/auction.ts'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView } from '../../shared/protocol.ts'
import type { Strings } from '../strings.ts'
import { cardName } from './cards.ts'

/**
 * What a screen reader says as the table changes (e3-t33, AC-3.9): a new deal, each call, the
 * contract, each card, who won each trick, the result, and whose turn it is. The table puts the
 * text in a polite live region; this works it out from the board before and after an update, so
 * it never says anything the viewer cannot already see.
 */

/** Pass, double and redouble are said in English in every language, as calls are shown (社長, 2026-10-25) */
const SPOKEN = { P: 'Pass', X: 'Double', XX: 'Redouble' } as Record<string, string>

/** 1 紅心, Pass, Double: a call as it is spoken */
export function spokenCall(call: Call, t: Strings): string {
  if (isBid(call)) return `${levelOf(call)} ${t.suitNames[strainOf(call)]}`
  return SPOKEN[call]
}

/** 4 黑桃 Double: a contract as it is spoken (without the declarer) */
export function spokenContract(contract: Contract, t: Strings): string {
  const doubled = contract.doubled ? ` ${SPOKEN[contract.doubled]}` : ''
  return `${contract.level} ${t.suitNames[contract.strain]}${doubled}`
}

export interface AnnounceContext {
  t: Strings
  /** The viewer's seat, if seated */
  me: Seat | null
  /** 北 Alice: how a seat is named aloud */
  who: (seat: Seat) => string
}

/** The sentences to announce between two views of the board, oldest first */
export function announcements(before: BoardView | null, after: BoardView | null, { t, me, who }: AnnounceContext): string[] {
  if (!after) return []
  const out: string[] = []
  const sameBoard = !!before && before.boardNo === after.boardNo
  if (!sameBoard) out.push(t.srNewBoard(after.boardNo, t.seatNames[after.dealer], t.vulNames[after.vul]))

  // On arrival at the table the calls and cards so far are not read out: they are on screen
  const arriving = !before
  // New calls (an undo shortens the auction: then nothing is said about the calls)
  const callsBefore = sameBoard ? before.auction.length : arriving ? after.auction.length : 0
  if (after.auction.length > callsBefore)
    for (const entry of after.auction.slice(callsBefore)) out.push(t.srCall(who(entry.seat), spokenCall(entry.call, t)))

  // The auction is over
  if (after.phase !== 'auction' && (arriving ? after.phase === 'play' : !sameBoard || before.phase === 'auction')) {
    if (after.contract) out.push(t.srContract(spokenContract(after.contract, t), who(after.contract.declarer)))
    else if (after.phase === 'finished') out.push(ALL_PASS)
  }

  // New cards, and who won each trick they finished
  const playedBefore = sameBoard || arriving ? (before ?? after).tricks.flatMap((x) => x.cards).length : 0
  let seen = 0
  for (const trick of after.tricks) {
    const start = seen
    seen += trick.cards.length
    if (seen <= playedBefore) continue
    for (const played of trick.cards.slice(Math.max(0, playedBefore - start))) out.push(t.srPlayed(who(played.seat), cardName(played.card, t)))
    if (trick.winner) {
      const index = after.tricks.indexOf(trick)
      const ns = after.tricks.slice(0, index + 1).filter((x) => x.winner === 'N' || x.winner === 'S').length
      out.push(t.srTrickWon(who(trick.winner), ns, index + 1 - ns))
    }
  }

  // The result
  if (after.phase === 'finished' && after.result && after.contract && (!sameBoard || before.phase !== 'finished')) {
    const diff = after.result.declarerTricks - (after.contract.level + 6)
    out.push(t.srResult(diff, after.result.scoreNS))
  }

  // Whose turn it is, when that changed
  const turnChanged = !sameBoard || before.turn !== after.turn || before.phase !== after.phase || callsBefore !== after.auction.length
  if (after.phase !== 'finished' && after.turn && turnChanged && !after.claim && !after.undo) {
    const mine = after.phase === 'auction' ? after.legalCalls.length > 0 : after.legalCards.length > 0
    if (mine && after.turn !== me) out.push(t.srYourDummyPlay)
    else if (mine) out.push(after.phase === 'auction' ? t.yourCall : t.yourPlay)
    else out.push(t.srTurn(who(after.turn), after.phase === 'auction'))
  }
  return out
}
