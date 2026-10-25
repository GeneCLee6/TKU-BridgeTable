import type { Page } from '@playwright/test'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView, LobbyView, Me, SeatOccupant, TableWire } from '../../shared/protocol.ts'

/**
 * A fixed club for the visual regression screenshots (e3-t37): the browser's API calls and its
 * WebSocket are answered here, so the real app runs without a Worker, the same every time.
 */

export const ME: Me = { id: 'amy', username: 'Amy', admin: true, permissions: [], friendOnlineNotice: true, profile: {} }

const person = (id: string, username: string): SeatOccupant => ({ id, username, online: true })
const robot = (seat: Seat, robotKind: 'tku' | 'gib' = 'gib'): SeatOccupant => ({
  id: `robot:${robotKind}:${seat}`,
  username: 'TKB',
  robot: true,
  robotKind,
  online: true,
})

const SEATS = { N: robot('N'), E: person('ben', 'Ben'), S: person('amy', 'Amy'), W: person('dan', 'Dan') }

/** One deal, by seat; South is the viewer, North is dummy */
const HANDS: Record<Seat, string[]> = {
  N: ['SA', 'SK', 'S9', 'S4', 'HQ', 'HJ', 'H3', 'DA', 'D8', 'D2', 'CK', 'C7', 'C3'],
  E: ['SJ', 'S8', 'S2', 'HK', 'H9', 'H6', 'H2', 'DJ', 'D9', 'D4', 'CQ', 'C9', 'C5'],
  S: ['SQ', 'ST', 'S6', 'S5', 'S3', 'HA', 'H7', 'DK', 'DQ', 'D5', 'CA', 'C8', 'C2'],
  W: ['S7', 'HT', 'H8', 'H5', 'H4', 'DT', 'D7', 'D6', 'D3', 'CJ', 'CT', 'C6', 'C4'],
}

const baseBoard: BoardView = {
  boardNo: 5,
  dealer: 'N',
  vul: 'Both',
  phase: 'auction',
  hands: { S: HANDS.S },
  handCounts: { N: 13, E: 13, S: 13, W: 13 },
  auction: [],
  contract: null,
  dummy: null,
  turn: 'N',
  tricks: [],
  tricksWon: { NS: 0, EW: 0 },
  legalCards: [],
  legalCalls: [],
  canUndo: false,
  canClaim: false,
}

const AUCTION = [
  { seat: 'N' as Seat, call: '1S', robot: true, alert: '' },
  { seat: 'E' as Seat, call: 'P' },
  { seat: 'S' as Seat, call: '2N', alert: '黑桃支持，邀局以上（Jacoby 2NT）' },
  { seat: 'W' as Seat, call: 'P' },
  { seat: 'N' as Seat, call: '3S', robot: true, alert: '' },
  { seat: 'E' as Seat, call: 'P' },
]

/** South to call after 1♠ – P – 2NT – P – 3♠ – P */
export const auctionBoard: BoardView = {
  ...baseBoard,
  auction: AUCTION,
  turn: 'S',
  legalCalls: ['P', 'X', ...['3N', '4C', '4D', '4H', '4S', '4N', '5C', '5D', '5H', '5S', '5N', '6C', '6D', '6H', '6S', '6N', '7C', '7D', '7H', '7S', '7N']],
  canUndo: true,
}

const contract = { level: 4, strain: 'S' as const, doubled: '' as const, declarer: 'S' as Seat }
const played = (seat: Seat, cards: string[]) => HANDS[seat].filter((c) => !cards.includes(c))

/** 4♠ by South: two tricks played, East has led to the third and South is to play */
export const playBoard: BoardView = {
  ...baseBoard,
  phase: 'play',
  auction: [...AUCTION, { seat: 'S', call: '4S' }, { seat: 'W', call: 'P' }, { seat: 'N', call: 'P' }, { seat: 'E', call: 'P' }],
  contract,
  dummy: 'N',
  hands: { S: played('S', ['HA', 'S3']), N: played('N', ['H3', 'S4']) },
  handCounts: { N: 11, E: 10, S: 11, W: 11 },
  tricks: [
    { leader: 'W', cards: [{ seat: 'W', card: 'HT' }, { seat: 'N', card: 'H3' }, { seat: 'E', card: 'HK' }, { seat: 'S', card: 'HA' }], winner: 'S' },
    { leader: 'S', cards: [{ seat: 'S', card: 'S3' }, { seat: 'W', card: 'S7' }, { seat: 'N', card: 'S4' }, { seat: 'E', card: 'S8' }], winner: 'E' },
    { leader: 'E', cards: [{ seat: 'E', card: 'D4' }] },
  ],
  tricksWon: { NS: 1, EW: 1 },
  turn: 'S',
  legalCards: ['DK', 'DQ', 'D5'],
  canUndo: true,
  canClaim: true,
}

/** The board over: 4♠ made with an overtrick, claimed */
export const resultBoard: BoardView = {
  ...playBoard,
  phase: 'finished',
  hands: HANDS,
  handCounts: { N: 13, E: 13, S: 13, W: 13 },
  turn: null,
  legalCards: [],
  canUndo: false,
  canClaim: false,
  tricksWon: { NS: 11, EW: 2 },
  result: { declarerTricks: 11, scoreNS: 650, claimed: true },
}

export function table(board: BoardView | null): TableWire {
  return {
    id: 't1',
    number: 3,
    hostId: 'amy',
    settings: { visibility: 'public', allowKibitz: true, boardMinutes: 0 },
    seats: SEATS,
    spectators: [],
    mySeat: 'S',
    board,
    boardsPlayed: 4,
    dealAt: null,
    chat: [
      { id: 'c1', at: Date.UTC(2026, 9, 20, 12, 0), userId: 'ben', username: 'Ben', text: '大家好' },
      { id: 'c2', at: Date.UTC(2026, 9, 20, 12, 1), userId: 'amy', username: 'Amy', text: '開始吧' },
    ],
    recent: [],
    boardEndsAt: null,
    waiting: null,
  }
}

export function lobby(atTable: boolean): LobbyView {
  const members = [
    { id: 'amy', username: 'Amy', online: true, tableNumber: atTable ? 3 : null, seat: atTable ? ('S' as Seat) : null },
    { id: 'ben', username: 'Ben', online: true, tableNumber: 3, seat: 'E' as Seat },
    { id: 'dan', username: 'Dan', online: true, tableNumber: 3, seat: 'W' as Seat },
    { id: 'eve', username: 'Eve', online: false, tableNumber: null, seat: null },
  ]
  return {
    online: members.filter((m) => m.online).map(({ id, username }) => ({ id, username })),
    members,
    tables: [
      {
        id: 't1',
        number: 3,
        hostName: 'Amy',
        settings: { visibility: 'public', allowKibitz: true, boardMinutes: 0 },
        welcome: true,
        seats: atTable ? SEATS : { ...SEATS, S: null },
        spectators: 0,
        boardsPlayed: 4,
        boardNo: 5,
      },
      {
        id: 't2',
        number: 4,
        hostName: 'Eve',
        settings: { visibility: 'public', allowKibitz: true, boardMinutes: 0 },
        welcome: true,
        // A long member name and both robot systems: the seat cells keep their size (lobby seat names)
        seats: { N: person('chris', 'Christopher Wellington'), E: robot('E'), S: null, W: robot('W', 'tku') },
        spectators: 0,
        boardsPlayed: 0,
        boardNo: null,
      },
    ],
    myTableId: atTable ? 't1' : null,
    friends: ['ben'],
    blocked: [],
  }
}

export interface Club {
  /** Signed in (else /api/me answers 401) */
  me?: Me | null
  table?: TableWire | null
  prefs?: Record<string, unknown>
}

/**
 * Answers the app's requests: /api/me, the WebSocket's lobby and table, and an empty answer for
 * anything else; display preferences go in before the page loads
 */
export async function serve(page: Page, { me = ME, table: tableWire = null, prefs = {} }: Club) {
  await page.addInitScript((stored) => {
    window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify(stored))
  }, { lang: 'zh', mode: 'light', sound: false, tableTourSeen: true, ...prefs })

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/me') return me ? route.fulfill({ json: { user: me } }) : route.fulfill({ status: 401, json: { error: 'notLoggedIn' } })
    if (path === '/api/challenges') return route.fulfill({ json: { challenges: [] } })
    if (path === '/api/featured') return route.fulfill({ json: { featured: [] } })
    return route.fulfill({ json: {} })
  })

  await page.routeWebSocket('**/ws', (ws) => {
    ws.send(JSON.stringify({ type: 'lobby', lobby: lobby(!!tableWire) }))
    ws.send(JSON.stringify({ type: 'notifications', notifications: { items: [], unread: 0 } }))
    ws.send(JSON.stringify({ type: 'directs', directs: { conversations: [], unread: 0 } }))
    if (tableWire) ws.send(JSON.stringify({ type: 'table', table: tableWire, now: Date.now() }))
    ws.onMessage(() => undefined)
  })
  // The table's own connection (ARCHITECTURE.md §5.10): open and quiet, the table came over the club's
  await page.routeWebSocket('**/ws/table/**', (ws) => ws.onMessage(() => undefined))
}
