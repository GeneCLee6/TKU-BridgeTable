import { boardLabel, cleanName, dealContent, IMPORT_LIMITS, importedContent, readImportedBoard, readImportedDeal, replayImported, type ImportCode, type ImportedBoard, type ImportedDeal } from '../shared/imports.ts'
import { formatDeal, parseDeal } from '../shared/pbn.ts'
import { SEATS, type Hands, type Seat } from '../shared/cards.ts'
import type { BoardState } from '../shared/game.ts'
import { boardNoFor } from '../shared/practice-sets/index.ts'
import type { BoardRecord, OwnDealInfo, PublicUser } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'
import type { PracticeTableProblem } from './modes.ts'
import type { Store } from './store.ts'
import { HELD_BACK } from './team-mode.ts'

/**
 * What a member brings in from files: BBO LIN boards as private records (`e4-t39`, ARCHITECTURE.md
 * §5.3, the visibility in §4) and PBN deals as their own list to practise (`e10-t09`, §5.11). The
 * browser parses the files (the free plan's 10 ms of CPU); here what it sends is checked again with
 * the engine (`shared/imports.ts`). Like `ClubService` this never touches a Cloudflare API: the hash
 * is WebCrypto, the same in the Worker and in Node.
 */

async function sha256Hex(text: string, chars: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, chars)
}

const fail = (code: ImportCode, board: number) => new ClubError(code, { board })

/** A request's boards, played through the engine; the first that is wrong refuses the whole request, by its number */
export function checkImportedBoards(body: unknown): { board: ImportedBoard; state: BoardState }[] {
  const boards = (body as { boards?: unknown } | null)?.boards
  if (!Array.isArray(boards) || boards.length === 0) throw new ClubError('importNoBoards')
  if (boards.length > IMPORT_LIMITS.batchBoards) throw new ClubError('importTooManyBoards', { max: IMPORT_LIMITS.batchBoards })
  return boards.map((value, i) => {
    const board = readImportedBoard(value)
    if (!board) throw fail('importBadBoard', boardLabel(value, i))
    const state = replayImported(board)
    if (typeof state === 'string') throw fail(state, board.boardNo)
    return { board, state }
  })
}

/**
 * A record's id: a hash of the member and what was played. The same board imported again by the same
 * member has the same id, so it is never kept twice; another member's copy of it is another record
 */
export const importedBoardId = async (userId: string, state: BoardState, names: Record<Seat, string>) =>
  `imp-${await sha256Hex(`${userId}\n${importedContent(state, names)}`, 32)}`

/**
 * The seats of an imported record. Three are text alone: no id, so no search, profile or list ever
 * ties them to an account, whatever they are called. The member's own seat has their id and the name
 * as the file wrote it; that is what makes the board theirs, and only theirs (below)
 */
export function importedPlayers(names: Record<Seat, string>, seat: Seat, userId: string): Record<Seat, PublicUser> {
  return Object.fromEntries(
    SEATS.map((s) => [s, { id: s === seat ? userId : '', username: cleanName(names[s], s) }]),
  ) as Record<Seat, PublicUser>
}

/**
 * An imported board's record. `revealAt` is `HELD_BACK`, the rule every list, search, detail page,
 * favourite, share and feature already applies to a board kept back (§4): only those at the table see
 * it, and the member is the only one at this table with an id. It never comes forward, as it has no
 * event; and with no `hist:`/`uhist:` summaries (`ClubService.writeRecord`) it is not in any count
 */
export function importedRecord(input: {
  id: string
  board: ImportedBoard
  state: BoardState
  userId: string
  finishedAt: number
  session: string
}): BoardRecord {
  return {
    id: input.id,
    tableNumber: 0,
    finishedAt: input.finishedAt,
    players: importedPlayers(input.board.names, input.board.seat, input.userId),
    board: input.state,
    mode: 'imported',
    revealAt: HELD_BACK,
    tableId: input.session,
  }
}

// ── The member's own deals (`e10-t09`) ───────────────────────────────────────────────────────────

/** One deal of the list, as stored (`practiceOwnDeals:<userId>`, newest first) */
export interface OwnDeal extends OwnDealInfo {
  /** `N:<north> <east> <south> <west>`; only the server deals it, the browser gets `OwnDealInfo` */
  hands: string
}

export const ownDealsKey = (userId: string) => `practiceOwnDeals:${userId}`

const info = ({ hands: _hands, ...rest }: OwnDeal): OwnDealInfo => rest

export class OwnDeals {
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number) {
    this.store = store
    this.now = now
  }

  /** With the hands: for the member's data export and for dealing, never for the page */
  async list(userId: string): Promise<OwnDeal[]> {
    return (await this.store.get<OwnDeal[]>(ownDealsKey(userId))) ?? []
  }

  async infos(userId: string): Promise<OwnDealInfo[]> {
    return (await this.list(userId)).map(info)
  }

  /** Adds a request's deals: the same deal again is not added twice. Answers how many of each and the whole list */
  async add(userId: string, body: unknown) {
    const deals = (body as { deals?: unknown } | null)?.deals
    if (!Array.isArray(deals) || deals.length === 0) throw new ClubError('importNoBoards')
    if (deals.length > IMPORT_LIMITS.batchDeals) throw new ClubError('importTooManyBoards', { max: IMPORT_LIMITS.batchDeals })
    const read: { deal: ImportedDeal; hands: Hands }[] = deals.map((value, i) => {
      const deal = readImportedDeal(value)
      if (!deal) throw fail('importBadBoard', boardLabel(value, i))
      const hands = parseDeal(deal.hands)
      if (!hands) throw fail('importBadDeal', deal.boardNo)
      return { deal, hands }
    })
    const list = await this.list(userId)
    const known = new Set(list.map((d) => d.id))
    const added: OwnDeal[] = []
    let order = 0
    for (const { deal, hands } of read) {
      const text = formatDeal(hands)
      const id = await sha256Hex(dealContent(deal, text), 24)
      if (known.has(id)) continue
      known.add(id)
      const { hands: _given, ...rest } = deal
      added.push({ ...rest, id, hands: text, addedAt: this.now() + order++ })
    }
    if (list.length + added.length > IMPORT_LIMITS.ownDeals) throw new ClubError('ownDealsFull', { max: IMPORT_LIMITS.ownDeals })
    const next = [...added.reverse(), ...list]
    if (added.length) await this.store.put(ownDealsKey(userId), next)
    return { added: added.length, duplicates: read.length - added.length, deals: next.map(info) }
  }

  /** Removes some of the member's deals; ids not in the list change nothing */
  async remove(userId: string, ids: unknown): Promise<OwnDealInfo[]> {
    if (!Array.isArray(ids) || ids.length > IMPORT_LIMITS.ownDeals) throw new ClubError('importNoBoards')
    const gone = new Set(ids)
    const list = await this.list(userId)
    const next = list.filter((d) => !gone.has(d.id))
    if (next.length) await this.store.put(ownDealsKey(userId), next)
    else await this.store.delete(ownDealsKey(userId))
    return next.map(info)
  }

  /** The chosen deals as a practice table deals them, in the order chosen; one no longer there is `boardGone` */
  async problems(userId: string, ids: readonly string[]): Promise<PracticeTableProblem[]> {
    const list = new Map((await this.list(userId)).map((d) => [d.id, d]))
    return ids.map((id) => {
      const deal = list.get(id)
      const hands = deal && parseDeal(deal.hands)
      if (!deal || !hands) throw new ClubError('boardGone', {}, 404)
      // The table takes the dealer and the vulnerability from the number (§5.11)
      return { boardNo: boardNoFor(deal.dealer, deal.vul), hands, ...(deal.title && { title: deal.title }) }
    })
  }

  /** When an account is deleted */
  async removeAll(userId: string) {
    await this.store.delete(ownDealsKey(userId))
  }
}
