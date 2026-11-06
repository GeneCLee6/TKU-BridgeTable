import type { AuctionCall, Call, Contract } from './auction.ts'
import type { Vulnerability } from './board.ts'
import type { Card, Seat } from './cards.ts'
import { DEAL_PRESET_IDS, type DealPreset } from './deal-presets.ts'
import type { BoardState } from './game.ts'
import { isRobotKind, type PracticeReview, type RobotKind } from './protocol.ts'

/**
 * 搭檔非同步叫牌練習 (`e10-t08`, AC-10.6, ARCHITECTURE.md §5.11): two members of a club bid a set of
 * deals on their own time, turn by turn. The inviter is South, the partner North; East and West
 * always pass. Each sees only their own hand and the auction so far until that board's auction
 * ends (`worker/views.ts`); then all four hands and 檢討. Never a table, never a record: nothing here
 * reaches the history, the rankings or the points. Pure, like the rest of `shared/`.
 */

/** Where the deals come from: any deal, one of the club's presets, or one of its practice sets (`shared/practice-sets/`) */
export type PartnerBidDeal = 'random' | DealPreset | 'set'
export const PARTNER_BID_DEALS: readonly PartnerBidDeal[] = ['random', ...DEAL_PRESET_IDS, 'set']

export interface PartnerBidSettings {
  deal: PartnerBidDeal
  /** The practice set, with `deal: 'set'` only */
  setId?: string
  /** How many deals the session has; a set with fewer has only those */
  boards: number
  /** The system 檢討 compares with: TKB in the club's system or in 2/1 */
  robotKind: RobotKind
}

export const PARTNER_BID_BOARDS_MAX = 8
/** A member's sessions at once, invitations included, whichever side they are on */
export const PARTNER_BID_ACTIVE_MAX = 5
/** A member's ended sessions kept; older ones go first */
export const PARTNER_BID_KEPT = 20
const DAY_MS = 24 * 60 * 60 * 1000
/** An invitation nobody answers ends after this */
export const PARTNER_BID_INVITE_MS = 7 * DAY_MS
/** A session where nobody has called for this long ends */
export const PARTNER_BID_IDLE_MS = 14 * DAY_MS
/** An ended session and its reviews stay this long */
export const PARTNER_BID_KEEP_MS = 30 * DAY_MS
/** No bell for a member who called in this session so recently and is still online: the page shows it */
export const PARTNER_BID_QUIET_MS = 2 * 60 * 1000

/** The seat each member bids: the deal presets are written from South, the inviter's */
export const PARTNER_BID_INVITER_SEAT: Seat = 'S'
export const PARTNER_BID_PARTNER_SEAT: Seat = 'N'
/** The seats that always pass */
export const PARTNER_BID_SILENT: readonly Seat[] = ['E', 'W']

export const PARTNER_BID_STATUSES = ['invited', 'active', 'finished', 'declined', 'abandoned', 'expired'] as const
export type PartnerBidStatus = (typeof PARTNER_BID_STATUSES)[number]
/** Whether a session still counts against the limit and can move on */
export const partnerBidOpen = (status: PartnerBidStatus) => status === 'invited' || status === 'active'

/** The server's copy of a session; only `worker/views.ts` turns it into what a member sees */
export interface PartnerBidSession {
  id: string
  inviterId: string
  partnerId: string
  status: PartnerBidStatus
  settings: PartnerBidSettings
  /** Where in a practice set the deals start, so the same set does not always give the same deals */
  offset: number
  /** How many boards are over */
  done: number
  /** The member whose call it is; none unless the session is active */
  turnId: string | null
  createdAt: number
  updatedAt: number
  /** When the sweep ends it (open) or deletes it (ended) */
  expiresAt: number
}

/** The server's copy of a dealt board, all four hands; boards are dealt one at a time, when reached */
export interface PartnerBidBoard {
  /** Its place in the session, 0-based */
  seq: number
  state: BoardState
  category?: string
  /** What a practice set's board teaches */
  note?: string
  /** 檢討, worked out after its auction ended */
  review?: PracticeReview
}

export interface PartnerBidPerson {
  id: string
  username: string
}

/** A session in the member's list: no cards at all */
export interface PartnerBidSummary {
  id: string
  status: PartnerBidStatus
  inviter: PartnerBidPerson
  partner: PartnerBidPerson
  /** The viewer's seat */
  seat: Seat
  settings: PartnerBidSettings
  boards: number
  done: number
  /** The viewer's call */
  yourTurn: boolean
  /** The member whose call it is */
  turnId: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

/** A board as one member sees it (`partnerBidView`) */
export interface PartnerBidBoardView {
  seq: number
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  /** Whether its auction ended */
  over: boolean
  /** The viewer's hand alone until the auction ends; then all four */
  hands: Partial<Record<Seat, Card[]>>
  auction: AuctionCall[]
  contract: Contract | null
  turn: Seat | null
  /** What the viewer may call, on their turn; only the server works it out */
  legalCalls: Call[]
  category?: string
  /** What a practice set's board teaches, once the auction ended */
  note?: string
  /** 檢討, once the auction ended; a part may still be being worked out */
  review?: PracticeReview
}

export interface PartnerBidView extends PartnerBidSummary {
  sessionBoards: PartnerBidBoardView[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Checks a new session's settings; `kind` is the inviter's own robots when none is asked for */
export function parsePartnerBidSettings(value: unknown, kind: RobotKind): { settings: PartnerBidSettings } | { field: string } {
  if (!isObject(value) || !Object.keys(value).every((k) => ['deal', 'setId', 'boards', 'robotKind'].includes(k))) return { field: 'settings' }
  const deal = value.deal ?? 'random'
  if (!PARTNER_BID_DEALS.includes(deal as PartnerBidDeal)) return { field: 'deal' }
  const boards = value.boards ?? 1
  if (!Number.isInteger(boards) || (boards as number) < 1 || (boards as number) > PARTNER_BID_BOARDS_MAX) return { field: 'boards' }
  const robotKind = value.robotKind ?? kind
  if (!isRobotKind(robotKind)) return { field: 'robotKind' }
  const common = { deal: deal as PartnerBidDeal, boards: boards as number, robotKind }
  if (deal !== 'set') return value.setId === undefined ? { settings: common } : { field: 'setId' }
  if (typeof value.setId !== 'string' || !value.setId) return { field: 'setId' }
  return { settings: { ...common, setId: value.setId } }
}
