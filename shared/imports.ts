import { contractOf, isAuctionComplete, legalCalls, seatToCall, type AuctionCall, type Call } from './auction.ts'
import type { Vulnerability } from './board.ts'
import { isCard, isSeat, nextSeat, SEATS, sideOf, suitOf, type Card, type Seat } from './cards.ts'
import { claimApprovers, finishBoard, remainingTricks, trickWinner, type BoardState, type PlayedCard } from './game.ts'
import { formatDeal, parseDeal } from './pbn.ts'
import { LIMITS } from './protocol.ts'

/**
 * Boards and deals brought in from files (`e4-t39`, `e10-t09`, ARCHITECTURE.md §5.3 and §5.11). The
 * free plan gives a request 10 ms of CPU, so the browser parses a file (`lin-import.ts`,
 * `pbn-import.ts`) and sends the result in small batches; the server only checks what it is sent,
 * by the rules a table uses: 52 different cards, a legal auction, legal play. Every
 * problem is a code of `shared/messages.ts` and the number of the board it is about, so the browser's
 * preview and the server's refusal say the same thing. Nothing here throws on bad input.
 */

/** How an imported board's record id starts (`importedBoardId`); no other record's id does, they are plain hex */
export const IMPORTED_BOARD_PREFIX = 'imp-'
export const isImportedBoardId = (id: string) => id.startsWith(IMPORTED_BOARD_PREFIX)

export const IMPORT_LIMITS = {
  /** A file or a paste */
  fileBytes: 1024 * 1024,
  /** Boards in one LIN file or paste */
  linBoards: 200,
  /** Boards in one request: this much checking and writing fits the free plan's CPU (ARCHITECTURE.md §5.3) */
  batchBoards: 10,
  /** Imported records a member keeps */
  linTotal: 1000,
  /** Deals in one PBN file or paste */
  pbnBoards: 200,
  /** Deals in one request */
  batchDeals: 50,
  /** Deals in a member's own list */
  ownDeals: 200,
  /** Calls in an imported auction: far past any real one, so a replay stays short */
  callsMax: 64,
  /** A player's name in a file */
  nameMax: 24,
  /** A deal's title (PBN's `Event`) */
  titleMax: 40,
  /** Boards in one page of the member's data export (`exportImported`): reading them and writing their LIN */
  exportPage: 20,
  /** Boards deleted in one scheduled step after an account is deleted */
  purgeStep: 10,
  /** A batch's session id, which groups the boards of one import */
  sessionMax: 24,
} as const

/** The codes a board's problem can have, all in `shared/messages.ts` with `{ board }` */
export type ImportCode = 'importBadBoard' | 'importBadDeal' | 'importBadAuction' | 'importBadPlay' | 'importBadClaim' | 'importUnfinished'

export interface ImportProblem {
  /** The board's number in the file, or its place there when it has none */
  board: number
  code: ImportCode
}

export interface ImportedCall {
  call: Call
  /** Alerted; the text may be empty */
  alert?: string
}

/** A finished board as the browser read it from a file */
export interface ImportedPlay {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  /** `N:<north> <east> <south> <west>` */
  hands: string
  calls: ImportedCall[]
  play: Card[]
  /** The tricks the declarer took in all, when the play ended with a claim */
  claim?: number
}

/** What a request carries for one board: the play, the names as written, and the seat the member says was theirs */
export interface ImportedBoard extends ImportedPlay {
  names: Record<Seat, string>
  seat: Seat
}

/** A deal as the browser read it from a PBN file, for the member's own list */
export interface ImportedDeal {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  hands: string
  title?: string
}

export const BOARD_NO_MAX = 9999

const CONTROL = /\p{Cc}+/gu

/** Text from a file as it may be kept: one line, no control characters, at most `max` characters */
export const cleanText = (text: string, max: number) => [...text.replace(CONTROL, ' ').trim()].slice(0, max).join('').trim()

/** A player's name from a file: text only, never looked up among the members; the seat's letter when there is none */
export const cleanName = (text: string, seat: Seat) => cleanText(text, IMPORT_LIMITS.nameMax) || seat

/**
 * Plays a board by the engine's rules: its finished state, or the code of what is wrong with it. A
 * board must be finished: every card played, a claim, or passed out.
 *
 * This walks the calls and the cards once instead of calling `makeCall` and `playCard`, because each
 * of those works out the whole board again for every card: about 3 ms a board on a busy machine, far
 * too much for 10 ms of CPU. The parts that say what is legal are the engine's (`legalCalls`,
 * `contractOf`, `trickWinner`, `finishBoard`), and `tests/engine/board-import.test.ts` plays random
 * boards, legal and broken, both ways and expects the same answer
 */
export function replayImported(board: ImportedPlay): BoardState | ImportCode {
  const hands = parseDeal(board.hands)
  if (!hands) return 'importBadDeal'
  if (board.calls.length > IMPORT_LIMITS.callsMax) return 'importBadAuction'
  const auction: AuctionCall[] = []
  for (const { call, alert } of board.calls) {
    if (!legalCalls(auction, board.dealer).has(call)) return 'importBadAuction'
    const seat = seatToCall(board.dealer, auction.length)
    auction.push(alert === undefined ? { seat, call } : { seat, call, alert: alert.slice(0, LIMITS.alertMax) })
  }
  if (!isAuctionComplete(auction)) return 'importUnfinished'
  const contract = contractOf(auction)
  const start: BoardState = { boardNo: board.boardNo, dealer: board.dealer, vul: board.vul, hands, auction, contract, play: [], phase: contract ? 'play' : 'auction' }
  if (!contract) return board.play.length || board.claim !== undefined ? 'importBadPlay' : finishBoard(start, 0, false)

  const held = Object.fromEntries(SEATS.map((seat) => [seat, new Set(hands[seat])])) as Record<Seat, Set<Card>>
  const trump = contract.strain === 'N' ? null : contract.strain
  const declaring = sideOf(contract.declarer)
  const play: PlayedCard[] = []
  let trick: PlayedCard[] = []
  let leader = nextSeat(contract.declarer)
  let won = 0
  for (const card of board.play) {
    const seat = nextSeat(leader, trick.length)
    if (!held[seat].has(card)) return 'importBadPlay'
    if (trick.length) {
      const led = suitOf(trick[0].card)
      if (suitOf(card) !== led && [...held[seat]].some((other) => suitOf(other) === led)) return 'importBadPlay'
    }
    held[seat].delete(card)
    const played = { seat, card }
    play.push(played)
    trick.push(played)
    if (trick.length === 4) {
      leader = trickWinner(trick, trump)
      if (sideOf(leader) === declaring) won++
      trick = []
    }
  }
  const state: BoardState = { ...start, play }
  if (play.length === 52) {
    if (board.claim !== undefined && board.claim !== won) return 'importBadClaim'
    return finishBoard(state, won, false)
  }
  if (board.claim === undefined) return 'importUnfinished'
  const share = board.claim - won
  if (!Number.isInteger(share) || share < 0 || share > remainingTricks(state)) return 'importBadClaim'
  const seat = contract.declarer
  return finishBoard({ ...state, claim: { seat, tricks: share, accepted: claimApprovers(state, seat) }, claimed: [seat] }, board.claim, true)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isBoardNo = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= BOARD_NO_MAX
const VULS: readonly unknown[] = ['None', 'NS', 'EW', 'Both']

/** The board's number for a problem: its own when it has one, or its place in the request */
export const boardLabel = (value: unknown, place: number) => (isObject(value) && isBoardNo(value.boardNo) ? value.boardNo : place + 1)

/** A board from a request as the server takes it, or null when it is not made of what a board is made of */
export function readImportedBoard(value: unknown): ImportedBoard | null {
  if (!isObject(value)) return null
  const { boardNo, dealer, vul, hands, calls, play, claim, names, seat } = value
  if (!isBoardNo(boardNo) || !isSeat(dealer) || !VULS.includes(vul) || !isSeat(seat)) return null
  if (typeof hands !== 'string' || hands.length > 100 || !Array.isArray(calls) || !Array.isArray(play) || play.length > 52) return null
  if (claim !== undefined && (!Number.isInteger(claim) || (claim as number) < 0 || (claim as number) > 13)) return null
  if (!isObject(names) || !play.every(isCard)) return null
  if (calls.length > IMPORT_LIMITS.callsMax) return null
  const read: ImportedCall[] = []
  for (const c of calls) {
    if (!isObject(c) || typeof c.call !== 'string' || c.call.length > 3) return null
    if (c.alert !== undefined && typeof c.alert !== 'string') return null
    read.push({ call: c.call, ...(c.alert !== undefined && { alert: cleanText(c.alert, LIMITS.alertMax) }) })
  }
  const cleaned = {} as Record<Seat, string>
  for (const s of SEATS) {
    const name = names[s]
    if (typeof name !== 'string' || name.length > 200) return null
    cleaned[s] = cleanName(name, s)
  }
  return {
    boardNo,
    dealer,
    vul: vul as Vulnerability,
    hands,
    calls: read,
    play: play as Card[],
    ...(claim !== undefined && { claim: claim as number }),
    names: cleaned,
    seat,
  }
}

/** A deal from a request as the server takes it, or null */
export function readImportedDeal(value: unknown): ImportedDeal | null {
  if (!isObject(value)) return null
  const { boardNo, dealer, vul, hands, title } = value
  if (!isBoardNo(boardNo) || !isSeat(dealer) || !VULS.includes(vul) || typeof hands !== 'string' || hands.length > 100) return null
  if (title !== undefined && typeof title !== 'string') return null
  const kept = typeof title === 'string' ? cleanText(title, IMPORT_LIMITS.titleMax) : ''
  return { boardNo, dealer, vul: vul as Vulnerability, hands, ...(kept && { title: kept }) }
}

/**
 * What makes an imported board the same board: the deal, its number, the calls, the play, the result
 * and the names as written (lower case), so the same deal played by others is another board. Not the
 * seat the member gave nor the explanations of the alerts, which do not change what was played. The
 * record's id is a hash of this and the member (`worker/imported-boards.ts`)
 */
export function importedContent(state: BoardState, names: Record<Seat, string>): string {
  return [
    state.boardNo,
    state.dealer,
    state.vul,
    formatDeal(state.hands),
    state.auction.map((c) => c.call).join(' '),
    state.play.map((p) => p.card).join(' '),
    state.result?.declarerTricks ?? '',
    SEATS.map((seat) => names[seat].toLowerCase()).join(','),
  ].join('|')
}

/** What makes a deal in a member's own list the same deal: the cards, the dealer and the vulnerability */
export const dealContent = (deal: Pick<ImportedDeal, 'dealer' | 'vul'>, hands: string) => `${deal.dealer}|${deal.vul}|${hands}`

/** The seat of the name a member gave, ignoring case; null when no seat has that name */
export function seatNamed(names: Record<Seat, string>, name: string): Seat | null {
  const wanted = name.trim().toLowerCase()
  if (!wanted) return null
  return SEATS.find((seat) => names[seat].toLowerCase() === wanted) ?? null
}

