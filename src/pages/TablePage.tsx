import { ALL_PASS } from '../lib/calls.ts'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Ban, EyeOff, Hand, Layers, List, Lock, Palette, Settings } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled, { css, keyframes } from 'styled-components'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, partnerOf, SEATS, sideOf, SUITS, suitOf, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import type { Trick } from '../../shared/game.ts'
import {
  DEAL_COUNTDOWN_MS,
  robotKindsFor,
  SLOW_TURN_MS,
  takesInvitees,
  type BoardView,
  type TableView,
} from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BiddingBox, type BiddingHints } from '../components/BiddingBox.tsx'
import { BoardInfo } from '../components/BoardInfo.tsx'
import { BookHints } from '../components/BookHints.tsx'
import { ChallengeBanner } from '../components/ChallengeBanner.tsx'
import { PracticeBanner } from '../components/PracticeBanner.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { MatchBanner } from '../components/MatchBanner.tsx'
import { DEAL_MS, DealAnimation } from '../components/DealAnimation.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { HandView } from '../components/HandView.tsx'
import { SeatPlate, type SeatAction } from '../components/SeatPlate.tsx'
import { TableAnnouncer } from '../components/TableAnnouncer.tsx'
import { TableSettingsDialog } from '../components/TableSettingsDialog.tsx'
import { TableTour } from '../components/TableTour.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ClaimPicker, FeltButton, FeltPanel, JoinRequests, Prompt, ResultPanel } from '../components/TablePanels.tsx'
import { PracticeReview } from '../components/PracticeReview.tsx'
import { TrickArea, TrickSpace, type CardOrigin, type Position } from '../components/TrickArea.tsx'
import { TrickPile } from '../components/TrickPile.tsx'
import { Button, Muted, PageMain } from '../components/ui.tsx'
import { spokenContract } from '../lib/announce.ts'
import { CARD_SCALE, sortForDisplay, suitOrder } from '../lib/cards.ts'
import { auctionBoxHeight, biddingBoxHeight, handHeight, type Orientation } from '../lib/measure.ts'
import { PACE, paceOf } from '../lib/motion.ts'
import { useTableSounds } from '../lib/sound/hooks.ts'
import { useCardChoice } from '../lib/useCardChoice.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useRobotRules } from '../lib/useRobotRules.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { mobile, tabletQuery } from '../styles/tokens.ts'
import { playerName, seatLetter } from '../strings.ts'

/** The levels in the seat menu: the ones offered now, and 橋士組 shown as coming later */

/**
 * The table, laid out like BBO: green felt, the viewer's seat always at the bottom, partner on
 * top, opponents left and right, every hand drawn above its name plate. Card sizes follow the size
 * of the felt, so the table fills the window. During the auction the middle holds the auction
 * table with room for the bidding box kept free below it, so neither ever moves or covers the
 * other; during play it holds the trick. Finished tricks go face down to the bottom-left corner;
 * undo and claim sit in the bottom-right one.
 *
 * A card you play glides to the middle at once, before the server answers; other players' cards
 * glide in from their hands. After the last card the trick stays a moment, then the result shows
 * with a three-second countdown, and the next deal slides out to the four hands.
 *
 * There is no "leave" button: going to any other page leaves the table.
 */

const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
`

/** Felt padding and gaps, used both by the styles and by the size calculation */
const PAD = { top: 10, bottom: 12, side: 16 }
const GAP = { row: 6, column: 12 }
/** Space between the auction table and the bidding box */
const STACK_GAP = 8
/** A name plate's height; on a computer it covers the foot of its hand's cards, as on BBO */
const PLATE = 34
/** On a phone the left and right plates are smaller, and cover a little less of their cards */
const PHONE_PLATE = 24
const PHONE_COVER = 10
/** A card you clicked is shown on the table at once; if the server has not taken it by then, it goes back */
const PENDING_MS = 4000

const Felt = styled.div<{ $phone: boolean; $portrait: boolean; $columns?: string }>`
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'info top status'
    'left center right'
    'tricks bottom actions';
  gap: ${GAP.row}px ${GAP.column}px;
  min-height: 0;
  overflow: auto;
  padding: ${PAD.top}px ${PAD.side}px ${PAD.bottom}px;
  background: radial-gradient(ellipse at center, ${({ theme }) => theme.table.felt} 55%, ${({ theme }) => theme.table.feltEdge});
  color: ${({ theme }) => theme.table.feltText};

  /* A tablet held upright (e3-t36): partner's hand and yours run the full width, so the cards can be larger */
  ${({ $portrait }) =>
    $portrait &&
    css`
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      grid-template-areas:
        'info . status'
        'top top top'
        'left center right'
        'bottom bottom bottom'
        'tricks . actions';
    `}

  ${({ $phone, $columns }) =>
    $phone &&
    css`
      /* The turned side seats are the same width, so the middle sits in the middle */
      grid-template-columns: ${$columns ?? 'auto minmax(0, 1fr) auto'};
      grid-template-rows: auto auto minmax(0, 1fr) auto auto auto;
      grid-template-areas:
        'info info status'
        'top top top'
        'left center right'
        'box box box'
        'bottom bottom bottom'
        'tricks tricks actions';
      gap: ${PHONE_GAP}px;
      padding: 8px 8px 12px;
      min-height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});
    `}
`

const Area = styled.div<{ $area: string; $align?: 'start' | 'center' | 'end'; $justify?: 'start' | 'center' | 'end' }>`
  grid-area: ${({ $area }) => $area};
  display: flex;
  flex-direction: column;
  align-items: ${({ $align }) => ($align === 'start' ? 'flex-start' : $align === 'end' ? 'flex-end' : 'center')};
  justify-content: ${({ $justify }) => ($justify === 'start' ? 'flex-start' : $justify === 'end' ? 'flex-end' : 'center')};
  gap: 6px;
  min-width: 0;
`

const Center = styled(Area)`
  position: relative;
  gap: ${STACK_GAP}px;
`

/** Prompts float over the trick so the table does not move */
const Overlay = styled.div`
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  pointer-events: none;
  & > * { pointer-events: auto; }
`

/** The bidding box's place under the auction: always there during the auction, empty until it is your call */
const BoxSlot = styled.div<{ $h: number }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: ${({ $h }) => $h}px;
  flex: none;
  position: relative;
`

/** 「現在替 北 叫」 over the bidding box, when the member bids for more than their own seat (`e10-t15`) */
const CallingFor = styled.div`
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  padding-bottom: 2px;
  color: ${({ theme }) => theme.table.feltText};
  font-size: 14px;
  font-weight: 700;
  text-align: center;
`

const appear = keyframes`
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: none; }
`

/**
 * A hand with its name plate below. On a computer the plate runs the width of the hand and covers
 * the foot of the cards, as BBO's name bar does; the rank and suit stay visible at the top. Just
 * after a deal the hand fades in as the packet from the middle arrives.
 */
const SeatBlock = styled.div<{ $overlap: number; $appear: boolean; $size?: { width: number; height: number } }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  max-width: 100%;
  ${({ $size }) =>
    $size &&
    css`
      justify-content: flex-end;
      width: ${$size.width}px;
      max-width: none;
      height: ${$size.height}px;
    `}
  & > [data-hand] {
    position: relative;
    display: flex;
    justify-content: center;
    min-width: 0;
    ${({ $appear }) =>
      $appear &&
      css`
        animation: ${appear} 0.28s ease-out ${DEAL_MS - 120}ms both;
      `}
  }
  & > [data-plate] {
    position: relative;
    z-index: 2;
    display: flex;
    justify-content: center;
    margin-top: -${({ $overlap }) => $overlap}px;
    ${({ $overlap }) => $overlap > 0 && '& > * { flex: 1 1 auto; }'}
  }
`

/**
 * On a phone, West and East sit turned towards the middle, as if facing each other across the
 * table: the seat is laid on its side in a box of fixed size, so the plate runs the full length
 * whatever the number of cards left, and both sides line up.
 */
const Turned = styled.div<{ $thick: number; $length: number; $dir: 1 | -1 }>`
  position: relative;
  flex: none;
  width: ${({ $thick }) => $thick}px;
  height: ${({ $length }) => $length}px;

  & > * {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
    transform: ${({ $dir, $thick, $length }) =>
      $dir === 1 ? `translateX(${$thick}px) rotate(90deg)` : `translateY(${$length}px) rotate(-90deg)`};
  }
`

const ContractBox = styled.button`
  display: grid;
  gap: 2px;
  min-width: 140px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: 16px;
  font-weight: 700;
  text-align: left;

  & > strong { font-size: 22px; }
`

/** The contract box and the auction it opens, which floats over the table instead of pushing it */
const StatusWrap = styled.div`
  position: relative;
`

const AuctionPopup = styled.div<{ $w: number }>`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  width: ${({ $w }) => $w}px;
`

const Actions = styled.div`
  display: grid;
  justify-items: stretch;
  gap: 8px;
  min-width: 110px;
`

const InfoRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;

  /* The board's compass keeps its size; the title wraps instead */
  & > :not(:last-child) { flex: none; }
`

const TableTitle = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 700;
  color: ${({ theme }) => theme.table.feltText};

  & > svg { color: ${({ theme }) => theme.table.feltMuted}; }
`

/** The round buttons under the table's name: always one row of their own, never split up */
const TitleTools = styled.span`
  display: flex;
  flex-basis: 100%;
  gap: 6px;
`

/** A small round button on the felt: the host's settings, and the card style and deck colours */
const RoundButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: ${({ theme }) => theme.table.shade};
  color: ${({ theme }) => theme.table.feltText};
`

/** 顯示四家 (`e10-t16`): a hand the member sees only because they asked to see all four */
const ShownTag = styled.span`
  position: absolute;
  top: -10px;
  left: 50%;
  z-index: 3;
  transform: translateX(-50%);
  padding: 1px 8px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.table.turn};
  color: ${({ theme }) => theme.table.panelText};
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
`

const Note = styled.div`
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: 15px;
  text-align: center;
`

/** Where each seat sits on screen when `bottom` is at the bottom */
function rotation(bottom: Seat): Record<Position, Seat> {
  return { bottom, left: nextSeat(bottom, 1), top: nextSeat(bottom, 2), right: nextSeat(bottom, 3) }
}

/**
 * The trick in the middle, as on BBO: a finished trick stays on the table until you click the
 * table or its winner leads to the next trick (`leading`: your own card on its way counts), then
 * its four cards go to the winner (`leaving`) and on to the pile in the corner. The last trick of
 * the board stays until the countdown starts (`holdLast`).
 */
function useTrickTable(board: BoardView | null, holdLast: boolean, leading: boolean, collectMs: number) {
  const boardNo = board?.boardNo ?? 0
  const tricks = board?.tricks ?? []
  const current = tricks.at(-1)
  const completed = tricks.filter((t) => t.winner).length
  // Finished tricks taken off the table so far, and the one on its way to its winner
  const [collected, setCollected] = useState({ boardNo, count: 0 })
  const [leaving, setLeaving] = useState<{ boardNo: number; index: number } | null>(null)
  const taken = collected.boardNo === boardNo ? Math.min(collected.count, completed) : 0
  const going = leaving && leaving.boardNo === boardNo && leaving.index < completed ? leaving : null

  const takeAway = () => {
    setCollected({ boardNo, count: completed })
    setLeaving({ boardNo, index: completed - 1 })
  }
  // The winner led before anyone clicked: the trick goes now
  const nextStarted = (!!current && !current.winner) || leading
  if (board?.phase === 'play' && nextStarted && completed > 0 && taken < completed) takeAway()

  useEffect(() => {
    if (!going) return
    const timer = setTimeout(() => setLeaving(null), collectMs)
    return () => clearTimeout(timer)
  }, [going, collectMs])

  const finished = board?.phase === 'finished'
  const waiting = board?.phase === 'play' && !!current?.winner && taken < completed
  const shown = !current ? null : finished ? (holdLast ? current : null) : current.winner && !waiting ? null : current
  const goingTrick = going ? tricks[going.index] : undefined
  return {
    shown,
    leaving: goingTrick?.winner ? { cards: goingTrick.cards, winner: goingTrick.winner, key: `${boardNo}:${going!.index}` } : undefined,
    /** The finished tricks already in the pile */
    pile: tricks.filter((t) => t.winner).slice(0, finished ? completed - (holdLast ? 1 : 0) : waiting ? completed - 1 : going ? going.index : completed),
    /** Clears a finished trick that is waiting on the table */
    collect: () => {
      if (waiting) takeAway()
    },
  }
}

/** The time, kept current a few times a second while `active` (for the countdown) */
function useClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 200)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

/**
 * The seat that has kept the table waiting SLOW_TURN_MS (AC-2.10), once that time has passed: its
 * plate blinks, its player hears a reminder, and the host may seat a robot there instead
 */
function useSlowSeat(waiting: TableView['waiting']): Seat | null {
  const key = waiting ? `${waiting.seat}:${waiting.since}` : ''
  const [slowKey, setSlowKey] = useState('')
  const since = waiting?.since
  useEffect(() => {
    if (since === undefined) return
    const timer = setTimeout(() => setSlowKey(key), Math.max(0, since + SLOW_TURN_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [key, since])
  return waiting && slowKey === key ? waiting.seat : null
}

/**
 * Tells you it is your turn when you are looking elsewhere: the tab's title says so (the sound is
 * in `useTableSounds`)
 */
function useTurnAlert(label: string | null) {
  const baseTitle = useRef(document.title)

  useEffect(() => {
    const base = baseTitle.current
    const update = () => {
      document.title = label && document.hidden ? `🔔 ${label} · ${base}` : base
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      document.title = base
    }
  }, [label])
}

/** The felt's size, so cards can be as large as the window allows */
function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1000, height: 700 })
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize({ width: Math.round(width), height: Math.round(height) })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

const clamp = (min: number, value: number, max: number) => Math.round(Math.max(min, Math.min(value, max)))

/** The felt's gap between columns on a phone */
const PHONE_GAP = 6

/**
 * On a phone, a face-up dummy on the left or right is laid out by suit, one overlapped row per
 * suit as on a computer, instead of lying on its side (社長 #4). The card width is the largest
 * that lets dummy's longest suit (as dealt, so it does not change during the play) fit beside the
 * trick; your own hand keeps its size. `otherSide` is the width of the seat on the other side.
 */
function phoneDummySizes(feltWidth: number, bottom: number, trick: number, longest: number, otherSide: number) {
  const fit = (w: number) => {
    const room = feltWidth - 2 * PHONE_GAP - otherSide - Math.round(w * 3.1)
    return { trick: w, width: clamp(30, room / (0.47 * (Math.max(1, longest) - 1) + 1), bottom * 0.9) }
  }
  // The trick keeps its size unless dummy's cards would get much smaller than your own
  const full = fit(trick)
  return full.width >= bottom * 0.75 ? full : fit(clamp(34, bottom * 0.62, trick))
}

/** Scale of the auction table and the bidding box against the viewer's card width */
const AUCTION_SCALE = 0.95
/** When the width sets the card size, the auction table grows into the spare height, up to this */
const AUCTION_MAX_SCALE = 1.3
const AUCTION_MAX = 130
const BOX_SCALE = 0.58
/** Upright, the height of the rows of the corners above and below the hands */
const PORTRAIT_CORNERS = 190
/** Rounds the auction table shows before it scrolls */
const AUCTION_ROWS = 5

/**
 * Sizes for each part of the table, from the felt's inner size. On a computer the viewer's card
 * width is the largest that lets the tallest moment, the auction (partner's hand, the auction
 * table, the bidding box, your own hand), fit the height, and lets your hand fit the middle
 * column; everything else scales from it.
 *
 * `scale` is the viewer's card size (CARD_SCALE). Small shrinks the cards that fit; large lets
 * your hand squeeze closer and the auction show fewer rounds before it scrolls, so larger cards
 * still fit the window.
 */
function tableSizes(feltWidth: number, feltHeight: number, scale = 1) {
  const phone = feltWidth < 700
  if (phone) {
    const bottom = clamp(40, feltWidth * 0.155 * scale, 84 * scale)
    // The side seats lie on their side: the card height sets their width, 13 cards their length
    const side = clamp(24, feltWidth * 0.085 * scale, 40 * scale)
    return {
      phone,
      bottom,
      top: clamp(36, bottom * 0.8, 70),
      side,
      sideThick: handHeight(side, 'horizontal') + PHONE_PLATE - PHONE_COVER,
      sideLength: Math.round(side * 7),
      trick: clamp(40, bottom * 0.78, 70),
      auction: 60,
      auctionRows: 4,
      auctionWidth: undefined,
      box: 46,
      portrait: false,
    }
  }
  // Upright (a tablet held portrait): the hands at the top and bottom have the full width, and
  // the corners (board, contract, tricks, undo and claim) have rows of their own
  const portrait = feltHeight > feltWidth * 1.15
  // contentRect excludes the padding; the grid gaps come out of it
  const height = portrait ? feltHeight - 4 * GAP.row - PORTRAIT_CORNERS : feltHeight - 2 * GAP.row
  const middleWidth = ((feltWidth - 2 * GAP.column) * 2) / 4
  const handRoom = portrait ? feltWidth : middleWidth
  const sideColumn = (feltWidth - 2 * GAP.column) / 4
  const rows = scale > 1 ? AUCTION_ROWS - 2 : AUCTION_ROWS
  const squeeze = 6.3 / Math.max(1, scale)
  const parts = (w: number) => {
    const top = Math.round(w * 0.85)
    // Upright, the side columns are narrow: their cards are no wider than a quarter of the column
    const side = portrait ? Math.min(Math.round(w * 0.8), Math.round(sideColumn / 3.4)) : Math.round(w * 0.8)
    const auction = Math.round(w * AUCTION_SCALE)
    const box = Math.round(w * BOX_SCALE)
    const middle = Math.max(auctionBoxHeight(auction, rows) + STACK_GAP + biddingBoxHeight(box), handHeight(side, 'rows'))
    return { top, side, auction, box, tall: handHeight(top, 'horizontal') + middle + handHeight(w, 'horizontal') }
  }
  // Thirteen overlapped cards take about seven card widths, and still read well squeezed to 6.3
  let bottom = Math.round(124 * Math.max(1, scale))
  while (bottom > 56 && (parts(bottom).tall > height || bottom * squeeze > handRoom)) bottom--
  if (scale < 1) bottom = Math.max(48, Math.round(bottom * scale))
  const { top, side, box } = parts(bottom)
  // If the width set the card size, the auction table takes up the height left over
  const middle = height - handHeight(top, 'horizontal') - handHeight(bottom, 'horizontal') - STACK_GAP - biddingBoxHeight(box)
  let auction = Math.round(bottom * AUCTION_SCALE)
  while (auction < Math.min(bottom * AUCTION_MAX_SCALE, AUCTION_MAX) && auctionBoxHeight(auction + 1, rows) <= middle) auction++
  return {
    phone,
    bottom,
    top,
    side,
    trick: Math.round(bottom * 0.88),
    auction,
    auctionRows: rows,
    auctionWidth: Math.round(Math.min(middleWidth, auction * 5.2)),
    box,
    sideThick: 0,
    sideLength: 0,
    portrait,
  }
}

export function TablePage() {
  const { tableId } = useParams()
  const { table, lobby, status, send } = useClub()
  const t = useT()

  // Only those the access mode lets in come to the table (others may ask at a request table), and a
  // table without kibitzers takes people only into its seats (a practice table only has watchers)
  const summary = lobby?.tables.find((x) => x.id === tableId)
  const closed =
    !!summary &&
    lobby?.myTableId !== tableId &&
    (!summary.welcome || (!summary.settings.allowKibitz && !summary.practice))
  // A team match's tables are listed with their match, for anyone to watch (§5.8)
  const listed = !!lobby && (!!summary || (lobby.matches ?? []).some((m) => !!tableId && Object.values(m.tables).includes(tableId)))

  useEffect(() => {
    if (status !== 'open' || !lobby || !tableId || closed) return
    if (lobby.myTableId === tableId || !listed) return
    send({ type: 'joinTable', tableId })
  }, [status, lobby, tableId, send, closed, listed])

  // Going to any other page leaves the table (a reload does not: the seat is kept while offline).
  // A challenge table is not closed by it: the server keeps it, paused, until playChallenge
  useEffect(
    () => () => {
      if (!window.location.pathname.startsWith('/table/')) send({ type: 'leaveTable' })
    },
    [send],
  )

  if (!lobby) return <PageMain>{t.connecting}</PageMain>
  // A challenge table is not in the lobby: it is there only for its player
  if (lobby.myTableId !== tableId && !listed)
    return (
      <PageMain>
        <Muted>{t.tableGone}</Muted>
        <p>
          <Link to="/">{t.navLobby}</Link>
        </p>
      </PageMain>
    )
  if (closed) {
    const asking = !summary.welcome && summary.settings.access === 'request'
    return (
      <PageMain>
        <Muted>{summary.welcome ? t.noKibitzTable : asking ? t.requestTable : t.closedTable}</Muted>
        {asking && (
          <p>
            <Button
              type="button"
              $variant="primary"
              disabled={!!summary.requested}
              onClick={() => send({ type: 'requestJoin', tableId: summary.id })}
            >
              <Hand size={16} aria-hidden />
              {summary.requested ? t.requestSent : t.askToJoin}
            </Button>
          </p>
        )}
        <p>
          <Link to="/">{t.navLobby}</Link>
        </p>
      </PageMain>
    )
  }
  if (!table || table.id !== tableId) return <PageMain>{t.loading}</PageMain>

  return <TableScreen table={table} send={send} />
}

function TableScreen({ table, send }: { table: TableView; send: ReturnType<typeof useClub>['send'] }) {
  const t = useT()
  const { cardStyle, deck, toggleCardStyle, toggleDeck, lang, confirmCalls, confirmPlays, cardSize, tableTourSeen, set: setPrefs } = usePreferences()
  const { user } = useAuth()
  const { error, lobby } = useClub()
  const navigate = useNavigate()
  const [feltRef, feltSize] = useSize()
  // On a tablet the side panel floats over the table, so it starts closed there (e3-t36)
  const onTablet = useMediaQuery(tabletQuery)
  const sizes = tableSizes(feltSize.width, feltSize.height, CARD_SCALE[cardSize])
  const board = table.board
  // Toggles that belong to one board are stored with its number, so they reset on the next deal
  const boardNo = board?.boardNo ?? 0
  const [auctionFor, setAuctionFor] = useState(0)
  const [lastTrickFor, setLastTrickFor] = useState(0)
  const [claimingFor, setClaimingFor] = useState(0)
  const [editingSettings, setEditingSettings] = useState(false)
  // 檢討 of a bidding practice's board (`e10-t07`): open only while that board stays finished
  const [reviewing, setReviewing] = useState(false)
  const reviewable = !!table.practice?.biddingOnly && board?.phase === 'finished'
  if (reviewing && !reviewable) setReviewing(false)
  const showAuction = auctionFor === boardNo
  const showLast = lastTrickFor === boardNo
  const claiming = claimingFor === boardNo
  const toggleLast = useCallback(() => setLastTrickFor((n) => (n === boardNo ? 0 : boardNo)), [boardNo])

  const me = table.mySeat
  const challenge = table.challenge
  const practice = table.practice
  // The seats I make the calls for (seat control, `e10-t15`): my own, and any others the server gave me
  const acts: Seat[] = table.acts ?? (me ? [me] : [])
  // Nobody runs a challenge, practice or team match table: its seats, robots and settings are
  // fixed; only who may watch a practice table changes (its member's settings button)
  const iAmHost = !!user && table.hostId === user.id && !challenge && !practice && !table.match
  const canConfigure = !!user && table.hostId === user.id && !challenge && !table.match
  const AccessIcon = { public: null, request: Hand, hidden: Lock, closed: Ban }[table.settings.access]
  const viewer = me ?? 'S'
  const at = rotation(viewer)
  const positionOf = (seat: Seat) => (Object.keys(at) as Position[]).find((p) => at[p] === seat)!
  const nameOf = (seat: Seat) => {
    const o = table.seats[seat]
    return o ? (o.robot ? `${playerName(t, o)} ${seatLetter[seat]}` : o.username) : seatLetter[seat]
  }
  const missing = SEATS.filter((s) => !table.seats[s]).length
  /** 北 Alice: a seat as a screen reader says it */
  const spokenSeat = (seat: Seat) => `${t.seatNames[seat]} ${table.seats[seat] ? nameOf(seat) : ''}`.trim()

  // A robot at the table (the partner, else an opponent): the bidding box tells how it will read
  // each call, as GIB does on BBO. The server works the meanings out (`callMeanings`); the page
  // only puts them into words
  const callMeanings = board?.callMeanings
  // The practice hint card reads the book in a robot partner's system (BookHints)
  const partnerSeat = me ? table.seats[partnerOf(me)] : null
  const rules = useRobotRules(!!callMeanings)
  const hints = useMemo((): BiddingHints | null => {
    if (!callMeanings || !rules) return null
    const robot = table.seats[callMeanings.robot]
    return {
      title: t.robotReads(robot ? playerName(t, robot) : t.robots[callMeanings.kind]),
      text: (call) => {
        const spec = callMeanings.meanings[call]
        return (spec && rules.describe(spec, lang)) || t.noRobotMeaning
      },
    }
  }, [callMeanings, rules, table.seats, t, lang])
  const trump = board?.contract && board.phase !== 'auction' ? board.contract.strain : null

  // The server moved me into my robot partner's declaring seat: say so until the first trick is done
  const [seatSeen, setSeatSeen] = useState({ seat: me, boardNo })
  const [swappedFor, setSwappedFor] = useState(0)
  if (seatSeen.seat !== me || seatSeen.boardNo !== boardNo) {
    if (seatSeen.boardNo === boardNo && seatSeen.seat && me && board?.contract?.declarer === me) setSwappedFor(boardNo)
    setSeatSeen({ seat: me, boardNo })
  }
  const swapNotice = swappedFor === boardNo && board?.phase === 'play' && board.tricks.every((x) => !x.winner)

  // ── The card you just clicked, shown on the table before the server confirms it ──
  const [pending, setPending] = useState<{ card: Card; seat: Seat; boardNo: number } | null>(null)
  const playedCards = board?.tricks.flatMap((x) => x.cards.map((c) => c.card)) ?? []
  const pendingShown = pending && pending.boardNo === boardNo && !playedCards.includes(pending.card) ? pending : null
  const playedCount = playedCards.length + (pendingShown ? 1 : 0)
  // Taken by the server (or a new board): stop tracking it, so an undo cannot bring it back
  if (pending && (pending.boardNo !== boardNo || playedCards.includes(pending.card))) setPending(null)
  // The server turned something down: the card goes back to the hand
  const [errorSeen, setErrorSeen] = useState(error?.at)
  if (error?.at !== errorSeen) {
    setErrorSeen(error?.at)
    setPending(null)
  }
  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => setPending(null), PENDING_MS)
    return () => clearTimeout(timer)
  }, [pending])
  const play = (seat: Seat) => (card: Card) => {
    setPending({ card, seat, boardNo })
    send({ type: 'play', card })
  }

  // ── Where every card was on screen at the last render, so a played card glides from there ──
  const cardRects = useRef(new Map<string, DOMRect>())
  useLayoutEffect(() => {
    const felt = feltRef.current
    if (!felt) return
    const rects = new Map<string, DOMRect>()
    for (const el of felt.querySelectorAll<HTMLElement>('[data-hand]')) {
      rects.set(`hand:${el.dataset.hand}`, el.getBoundingClientRect())
      for (const card of el.querySelectorAll<HTMLElement>('[data-card]')) rects.set(card.dataset.card!, card.getBoundingClientRect())
    }
    cardRects.current = rects
  })
  const origin: CardOrigin = (card, seat) => cardRects.current.get(card) ?? cardRects.current.get(`hand:${seat}`)

  // ── A new deal: packets slide out from the middle and the hands fade in ──
  const [dealtSeen, setDealtSeen] = useState(boardNo)
  const [dealing, setDealing] = useState(0)
  if (boardNo !== dealtSeen) {
    setDealtSeen(boardNo)
    setDealing(boardNo)
  }
  useEffect(() => {
    if (!dealing) return
    const timer = setTimeout(() => setDealing(0), DEAL_MS + PACE.dealHoldMs)
    return () => clearTimeout(timer)
  }, [dealing])
  const myTurn =
    board?.phase === 'auction' && board.legalCalls.length > 0 && !board.undo
      ? 'call'
      : board?.phase === 'play' && board.legalCards.length > 0 && !board.claim
        ? 'play'
        : null
  useTurnAlert(myTurn === 'call' ? t.yourCall : myTurn === 'play' ? t.yourPlay : null)
  const slowSeat = useSlowSeat(table.waiting)

  // ── After the board: the last trick stays, then a countdown to the next deal ──
  const finished = board?.phase === 'finished'
  const now = useClock(finished && table.dealAt !== null)
  const toDeal = finished && table.dealAt !== null ? table.dealAt - now : null
  const playedOut = finished && board!.tricks.length === 13 && !!board!.tricks[12].winner && !board!.result?.claimed
  const holdLast = playedOut && toDeal !== null && toDeal > DEAL_COUNTDOWN_MS
  const seconds = toDeal === null ? null : Math.max(1, Math.ceil(Math.min(toDeal, DEAL_COUNTDOWN_MS) / 1000))

  const leadingNow = !!pendingShown && (!board?.tricks.length || !!board.tricks.at(-1)!.winner)
  // The animations go at the table's robot speed (出牌速度), the slowest of the people seated
  const pace = paceOf(table.robotSpeed)
  const trickTable = useTrickTable(board, holdLast, leadingNow, pace.collectMs)
  // Every sound at the table; a minute on one call or card brings the reminder (slowSeat)
  useTableSounds({
    table,
    userId: user?.id,
    host: iAmHost,
    playedCount,
    lastPlayer: pendingShown?.seat ?? board?.tricks.at(-1)?.cards.at(-1)?.seat ?? null,
    collecting: trickTable.leaving?.key,
    myTurn,
    slow: !!me && slowSeat === me,
  })
  let shownTrick: Trick | null = trickTable.shown
  if (pendingShown && board?.phase === 'play') {
    const current = board.tricks.at(-1)
    const base = current && !current.winner ? current : { leader: pendingShown.seat, cards: [] }
    shownTrick = { ...base, cards: [...base.cards, { seat: pendingShown.seat, card: pendingShown.card }], winner: undefined }
  }

  /** Suits in BBO's order: colours alternate around the suits the hand was dealt, trumps first */
  const orderFor = (seat: Seat, cards: string[]) => {
    const played = board?.tricks.flatMap((x) => x.cards).filter((x) => x.seat === seat).map((x) => x.card) ?? []
    const held = [...new Set([...cards, ...played].map(suitOf))] as Suit[]
    return suitOrder(trump, held)
  }

  // ── Choosing the card: a second click or Enter plays it (confirm cards), arrows move between legal cards ──
  const turnSeat = board?.turn
  const turnHand = myTurn === 'play' && !pendingShown && turnSeat ? board.hands[turnSeat] : undefined
  const choosable = turnHand ? sortForDisplay(turnHand, orderFor(turnSeat!, turnHand)).filter((c) => board!.legalCards.includes(c)) : []
  const { chosen, pick } = useCardChoice({
    cards: choosable,
    confirm: confirmPlays,
    turn: `${boardNo}:${playedCount}`,
    onPlay: (card) => turnSeat && play(turnSeat)(card),
  })

  const turnedSides = sizes.phone && cardStyle === 'cards'
  // On a phone a face-up dummy on the left or right goes in rows by suit; the hidden hand on the
  // other side is then only its name plate, to leave the room to dummy (社長 #4)
  const dummySeat = turnedSides && board && board.phase !== 'auction' ? board.dummy : null
  const dummyAt = dummySeat && board?.hands[dummySeat] ? positionOf(dummySeat) : null
  const sideDummy = dummyAt === 'left' || dummyAt === 'right' ? dummyAt : null
  const across = sideDummy && (sideDummy === 'left' ? 'right' : 'left')
  const plateOnly = !!across && !board?.hands[at[across]]
  const dummySizes = (() => {
    if (!sideDummy || !board || !dummySeat) return null
    const played = board.tricks.flatMap((x) => x.cards).filter((x) => x.seat === dummySeat).map((x) => x.card)
    const dealt = [...board.hands[dummySeat]!, ...played]
    const longest = Math.max(...SUITS.map((suit) => dealt.filter((card) => suitOf(card) === suit).length))
    return phoneDummySizes(feltSize.width, sizes.bottom, sizes.trick, longest, plateOnly ? PHONE_PLATE : sizes.sideThick)
  })()
  const phoneColumns = turnedSides
    ? (['left', 'right'] as const)
        .map((p) => (p === sideDummy ? 'auto' : `${p === across && plateOnly ? PHONE_PLATE : sizes.sideThick}px`))
        .join(' minmax(0, 1fr) ')
    : undefined

  /** What the viewer may do with a seat: sit there, and for the host: robots and asking people to leave */
  const seatActions = (seat: Seat): SeatAction[] => {
    const occupant = table.seats[seat]
    const actions: SeatAction[] = []
    if (challenge || practice || table.match) return actions
    const between = !board || board.phase === 'finished'
    // A free seat (or a robot's) can be taken; someone already seated moves only between boards
    if ((!occupant || (occupant.robot && !me)) && (!me || between))
      actions.push({ label: t.takeSeat(seatLetter[seat]), onSelect: () => send({ type: 'sit', tableId: table.id, seat }) })
    // The host seats TKB in the club's system or in 2/1 (GIB-compatible); a host without
    // `tkuSystem` has one TKB, the 2/1 one, and no choice (ROBOT.md §7)
    if (iAmHost && !occupant) {
      const kinds = robotKindsFor(user)
      for (const kind of kinds)
        actions.push({ label: kinds.length > 1 ? t.addRobots[kind] : t.addRobot, onSelect: () => send({ type: 'addRobot', seat, kind }) })
    }
    if (iAmHost && occupant?.robot)
      actions.push({ label: t.removeRobot, onSelect: () => send({ type: 'removeRobot', seat }), tone: 'danger' })
    if (iAmHost && occupant && !occupant.robot && occupant.id !== user?.id && slowSeat === seat)
      actions.push({ label: t.replaceWithRobot, onSelect: () => send({ type: 'replaceWithRobot', seat }), tone: 'danger' })
    if (iAmHost && occupant && !occupant.robot && occupant.id !== user?.id)
      actions.push({ label: t.kick, onSelect: () => send({ type: 'kick', seat }), tone: 'danger' })
    return actions
  }

  const seatBlock = (position: Position) => {
    const seat = at[position]
    const occupant = table.seats[seat]
    // While the last trick is still on the table every hand is empty; then the deal is shown again
    const dealt = holdLast ? [] : board?.hands[seat]
    const cards = pendingShown?.seat === seat ? dealt?.filter((c) => c !== pendingShown.card) : dealt
    const side = position === 'left' || position === 'right'
    const role =
      board?.contract && board.phase !== 'auction'
        ? board.contract.declarer === seat
          ? 'declarer'
          : board.dummy === seat
            ? 'dummy'
            : undefined
        : undefined
    const dummyRows = position === sideDummy && !!dummySizes
    const onlyPlate = position === across && plateOnly
    const width = dummyRows && dummySizes ? dummySizes.width : position === 'bottom' ? sizes.bottom : side ? sizes.side : sizes.top
    // On a phone the side seats lie on their side (cards only; text hands stay as they are)
    const turned = side && turnedSides && !dummyRows
    // Face-up hands on the left and right go in rows by suit (BBO's dummy), which is narrow
    const orientation: Orientation = dummyRows
      ? 'rows'
      : !side || turned
        ? 'horizontal'
        : sizes.phone
          ? 'vertical'
          : cards
            ? 'rows'
            : 'horizontal'
    // Seen only because the member turned on 顯示四家: marked, so it is never taken for their own
    const exposedDummy = board?.dummy === seat && !!board?.tricks.some((trick) => trick.cards.length > 0)
    const shownOnly =
      !!practice?.showHands && !!me && !!cards && board?.phase !== 'finished' && !acts.includes(seat) && !exposedDummy
    // Only the plate: an empty hand stays, so a card played from it glides from there
    const hand = board && onlyPlate ? (
      <div data-hand={seat} data-hand-at={position} data-plate-only />
    ) : board && (
      <div data-hand={seat} data-hand-at={position} data-shown={shownOnly || undefined}>
        {shownOnly && <ShownTag>{t.handShown}</ShownTag>}
        <HandView
          cards={cards}
          count={holdLast ? 0 : board.handCounts[seat] - (pendingShown?.seat === seat ? 1 : 0)}
          width={width}
          style={cardStyle}
          orientation={orientation}
          order={cards ? orderFor(seat, cards) : undefined}
          playable={board.turn === seat && !pendingShown ? board.legalCards : []}
          chosen={board.turn === seat ? chosen : null}
          onPlay={pick}
          label={`${seatLetter[seat]} ${nameOf(seat)}`}
        />
      </div>
    )
    const cover = !hand || onlyPlate || cardStyle !== 'cards' ? 0 : !sizes.phone ? PLATE : turned ? PHONE_COVER : 0
    const block = (
      <SeatBlock
        $overlap={cover}
        $appear={dealing === boardNo && dealing > 0}
        $size={turned ? { width: sizes.sideLength, height: onlyPlate ? PHONE_PLATE : sizes.sideThick } : undefined}
      >
        {hand}
        <div data-plate>
          <SeatPlate
            seat={seat}
            occupant={occupant}
            vulnerable={board ? isVulnerable(board.vul, seat) : false}
            turn={!!board && board.turn === seat && board.phase !== 'finished'}
            role={role}
            isMe={seat === me}
            isHost={!!occupant && occupant.id === table.hostId}
            actions={seatActions(seat)}
            menuUp={position === 'bottom'}
            compact={side && sizes.phone}
            endsAt={table.boardEndsAt}
            slow={slowSeat === seat}
          />
        </div>
      </SeatBlock>
    )
    return turned ? (
      <Turned $thick={onlyPlate ? PHONE_PLATE : sizes.sideThick} $length={sizes.sideLength} $dir={position === 'left' ? 1 : -1}>
        {block}
      </Turned>
    ) : (
      block
    )
  }

  const remaining = board ? 13 - board.tricks.filter((x) => x.winner).length : 0
  // Undo and claim stay on the table for the whole board; the server says when each may be used
  const canClaim = !!board && board.canClaim && !pendingShown
  const canUndo = !!board && board.canUndo && !pendingShown

  const claimPrompt = () => {
    const claim = board?.claim
    if (!claim) return null
    const text = t.claimBy(nameOf(claim.seat), claim.tricks)
    if (me && claim.approvers.includes(me) && !claim.accepted.includes(me))
      return (
        <Prompt text={text} yes={t.accept} no={t.reject} onAnswer={(accept) => send({ type: 'claimRespond', accept })} />
      )
    return <Prompt text={text} detail={t.claimWaiting(claim.approvers.length - claim.accepted.length)} />
  }

  const undoPrompt = () => {
    const undo = board?.undo
    if (!undo) return null
    // A call I took back for another of my seats is mine to wait on, not to answer
    if (acts.includes(undo.seat)) return <Prompt text={t.undoRequested} />
    if (me && sideOf(me) !== sideOf(undo.seat))
      return (
        <Prompt
          text={t.undoBy(nameOf(undo.seat))}
          yes={t.agree}
          no={t.reject}
          onAnswer={(accept) => send({ type: 'undoRespond', accept })}
        />
      )
    return <Prompt text={me === undo.seat ? t.undoRequested : t.undoBy(nameOf(undo.seat))} />
  }

  /** The bidding box when it is your call, an undo question while one is open, otherwise empty room */
  const biddingSlot = (b: BoardView): ReactNode => (
    <BoxSlot $h={biddingBoxHeight(sizes.box)} data-tour="bidding-box">
      {b.undo
        ? undoPrompt()
        : b.legalCalls.length > 0 &&
          b.turn && (
            <>
              {/* Bidding for more than my own seat: say for which one this call is */}
              {table.acts && <CallingFor role="status">{t.callingFor(t.seatNames[b.turn])}</CallingFor>}
              <BiddingBox
                legal={b.legalCalls}
                onCall={(call, alert) => send({ type: 'call', call, alert, seat: b.turn! })}
                size={sizes.box}
                hints={hints}
                confirm={confirmCalls}
              />
            </>
          )}
    </BoxSlot>
  )

  const trickWidth = dummySizes?.trick ?? sizes.trick
  const trickView = (trick: Trick | null) =>
    trick || trickTable.leaving ? (
      <TrickArea
        cards={trick?.cards ?? []}
        positionOf={positionOf}
        winner={trick?.winner}
        width={trickWidth}
        label={t.thisTrick}
        origin={origin}
        leaving={trickTable.leaving}
        pace={pace}
      />
    ) : (
      <TrickSpace $w={trickWidth} />
    )

  const center = () => {
    if (!board)
      return (
        <FeltPanel>
          <div>{t.waitingForPlayers(missing)}</div>
        </FeltPanel>
      )
    if (board.phase === 'auction') {
      const names = Object.fromEntries(SEATS.map((seat) => [seat, nameOf(seat)])) as Record<Seat, string>
      return (
        <>
          <AuctionBox
            auction={board.auction}
            dealer={board.dealer}
            vul={board.vul}
            viewer={viewer}
            turn={board.turn}
            names={names}
            size={sizes.auction}
            maxRows={sizes.auctionRows}
            width={sizes.auctionWidth}
          />
          {!sizes.phone && biddingSlot(board)}
        </>
      )
    }
    if (board.phase === 'finished') {
      if (holdLast) return trickView(shownTrick)
      return (
        <ResultPanel
          board={board}
          declarerName={board.contract ? nameOf(board.contract.declarer) : undefined}
          seconds={seconds}
          note={practice?.problem?.note}
          onReview={reviewable ? () => setReviewing(true) : undefined}
        />
      )
    }
    return (
      <>
        {trickView(shownTrick)}
        <Overlay>
          {claiming && canClaim && (
            <ClaimPicker
              remaining={remaining}
              onClaim={(tricks) => {
                send({ type: 'claim', tricks })
                setClaimingFor(0)
              }}
              onCancel={() => setClaimingFor(0)}
            />
          )}
          {claimPrompt()}
          {undoPrompt()}
          {!board.claim && board.rejectedClaim && (
            <Prompt
              text={t.claimRejected(nameOf(board.rejectedClaim.by))}
              detail={t.claimBy(nameOf(board.rejectedClaim.seat), board.rejectedClaim.tricks)}
            />
          )}
        </Overlay>
      </>
    )
  }

  const infoSize = Math.max(20, Math.round(sizes.bottom * 0.3))

  return (
    <Layout>
      <Felt ref={feltRef} $phone={sizes.phone} $portrait={sizes.portrait} $columns={phoneColumns} onClick={trickTable.collect}>
        {dealing > 0 && dealing === boardNo && (
          <DealAnimation key={dealing} felt={feltRef} width={Math.round(sizes.side * 0.8)} />
        )}
        {canConfigure && table.requests && (
          <JoinRequests requests={table.requests} onAnswer={(userId, accept) => send({ type: 'answerRequest', userId, accept })} />
        )}
        <Area $area="info" $align="start" $justify="start">
          <InfoRow>
            {board && <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={at} size={infoSize} />}
            <TableTitle>
              {challenge ? (
                <ChallengeBanner challenge={challenge} />
              ) : practice ? (
                <PracticeBanner practice={practice} />
              ) : table.match ? (
                <MatchBanner match={table.match} watching={!me} />
              ) : (
                <>
                  <span>
                    {t.tableName(table.number)} · {t.boardsPlayed(table.boardsPlayed)}
                  </span>
                  {AccessIcon && table.settings.access !== 'public' && (
                    <AccessIcon size={15} aria-label={t.accessBadge[table.settings.access]} role="img" />
                  )}
                  {!table.settings.allowKibitz && <EyeOff size={15} aria-label={t.noKibitz} role="img" />}
                </>
              )}
              {/* Card faces or text, two or four colours: here at the table, not in the header (社長 #8) */}
              <TitleTools>
                <RoundButton
                  type="button"
                  aria-label={cardStyle === 'cards' ? t.styleToText : t.styleToCards}
                  title={cardStyle === 'cards' ? t.styleToText : t.styleToCards}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleCardStyle()
                  }}
                >
                  {cardStyle === 'cards' ? <List size={16} aria-hidden /> : <Layers size={16} aria-hidden />}
                </RoundButton>
                <RoundButton
                  type="button"
                  aria-label={deck === 'two' ? t.deckToFour : t.deckToTwo}
                  title={deck === 'two' ? t.deckToFour : t.deckToTwo}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleDeck()
                  }}
                >
                  <Palette size={16} aria-hidden />
                </RoundButton>
                {canConfigure && (
                  <RoundButton
                    type="button"
                    aria-label={t.tableSettings}
                    title={t.tableSettings}
                    onClick={(event) => {
                      event.stopPropagation()
                      setEditingSettings(true)
                    }}
                  >
                    <Settings size={16} aria-hidden />
                  </RoundButton>
                )}
              </TitleTools>
            </TableTitle>
          </InfoRow>
        </Area>
        <Area $area="status" $align="end" $justify="start">
          {board && board.phase !== 'auction' && (
            <StatusWrap>
              <ContractBox
                type="button"
                onClick={() => setAuctionFor(showAuction ? 0 : boardNo)}
                aria-expanded={showAuction}
                aria-label={t.srContractBox(
                  board.contract ? `${spokenContract(board.contract, t)} ${t.seatNames[board.contract.declarer]}` : ALL_PASS,
                  board.tricksWon.NS,
                  board.tricksWon.EW,
                )}
              >
                <strong>
                  <ContractLabel contract={board.contract} onCard />
                </strong>
                <span>
                  NS {board.tricksWon.NS} · EW {board.tricksWon.EW}
                </span>
              </ContractBox>
              {showAuction && (
                <AuctionPopup $w={Math.round(Math.max(sizes.side, 56) * 4.4)}>
                  <AuctionBox
                    auction={board.auction}
                    dealer={board.dealer}
                    vul={board.vul}
                    viewer={viewer}
                    size={sizes.side}
                    maxRows={sizes.phone ? 4 : 5}
                  />
                </AuctionPopup>
              )}
            </StatusWrap>
          )}
        </Area>
        <Area $area="top">{seatBlock('top')}</Area>
        <Area $area="left">{seatBlock('left')}</Area>
        <Center $area="center" data-center data-tour="center">
          {center()}
        </Center>
        <Area $area="right">{seatBlock('right')}</Area>
        {sizes.phone && board?.phase === 'auction' && <Area $area="box">{biddingSlot(board)}</Area>}
        <Area $area="bottom" $justify="end">
          {seatBlock('bottom')}
        </Area>
        <Area $area="tricks" $align="start" $justify="end">
          {board && board.phase !== 'auction' && (
            <TrickPile
              tricks={trickTable.pile}
              side={sideOf(viewer)}
              positionOf={positionOf}
              width={sizes.bottom}
              open={showLast}
              onToggle={toggleLast}
            />
          )}
        </Area>
        <Area $area="actions" $align="end" $justify="end" data-tour="actions">
          <Actions>
            {!me && <Note>{t.kibitzing}</Note>}
            {swapNotice && <Note role="status">{t.swappedToDeclare}</Note>}
            {challenge && challenge.played >= challenge.boards && board?.phase === 'finished' && (
              <Note role="status">
                {t.challengeAllDone} <Link to="/">{t.navLobby}</Link>
              </Note>
            )}
            {practice && me && (
              <>
                {practice.biddingOnly ? (
                  // A bidding practice waits for the member between boards: the next one, or this one again
                  <>
                    <FeltButton type="button" $tone="plain" title={t.rebidHint} onClick={() => send({ type: 'rebid' })}>
                      {t.rebid}
                    </FeltButton>
                    <FeltButton
                      type="button"
                      $tone={finished ? 'go' : 'plain'}
                      title={t.nextBoardHint}
                      onClick={() => send({ type: 'redeal' })}
                    >
                      {t.nextBoard}
                    </FeltButton>
                  </>
                ) : (
                  <FeltButton type="button" $tone="plain" title={t.redealHint} onClick={() => send({ type: 'redeal' })}>
                    {t.redeal}
                  </FeltButton>
                )}
                <FeltButton
                  type="button"
                  $tone="plain"
                  aria-pressed={!!practice.showHands}
                  title={t.showHandsHint}
                  onClick={() => send({ type: 'showHands', show: !practice.showHands })}
                >
                  {practice.showHands ? t.hideHands : t.showHands}
                </FeltButton>
                <FeltButton type="button" $tone="plain" onClick={() => navigate('/')}>
                  {t.endPractice}
                </FeltButton>
              </>
            )}
            {board && me && board.phase !== 'finished' && (
              <>
                <FeltButton
                  type="button"
                  $tone="plain"
                  disabled={!canUndo}
                  title={challenge ? t.challengeNoUndo : table.match ? t.teamMatch.noUndo : undefined}
                  data-tour="undo"
                  onClick={() => send({ type: 'undoRequest' })}
                >
                  {t.undo}
                </FeltButton>
                <FeltButton
                  type="button"
                  $tone="plain"
                  disabled={!canClaim}
                  aria-expanded={claiming && canClaim}
                  data-tour="claim"
                  onClick={() => setClaimingFor(claiming ? 0 : boardNo)}
                >
                  {t.claim}
                </FeltButton>
              </>
            )}
          </Actions>
        </Area>
      </Felt>
      {reviewing && board && (
        <PracticeReview
          board={board}
          review={practice?.review}
          note={practice?.problem?.note}
          names={Object.fromEntries(SEATS.map((seat) => [seat, nameOf(seat)]))}
          onClose={() => setReviewing(false)}
        />
      )}
      {editingSettings && canConfigure && (
        <TableSettingsDialog
          title={t.tableSettings}
          submitLabel={t.save}
          initial={table.settings}
          practice={!!practice}
          members={(lobby?.members ?? []).filter((m) => m.id !== user?.id && !lobby?.blocked.includes(m.id))}
          invited={table.invited?.map((u) => u.id) ?? []}
          onClose={() => setEditingSettings(false)}
          onSubmit={(settings, invitees) => {
            setEditingSettings(false)
            // A public or closed table keeps its invitation list for when invitations count again;
            // at a practice table only who may watch changes
            send({
              type: 'updateTableSettings',
              settings: practice ? { access: settings.access } : settings,
              ...(takesInvitees(settings.access) && { invitees }),
            })
          }}
        />
      )}
      <TableAnnouncer board={board} me={me} who={spokenSeat} />
      {!tableTourSeen && <TableTour onClose={() => setPrefs({ tableTourSeen: true })} />}
      <SidePanel
        tabs={['chat', 'conventions', 'people', 'messages', 'history']}
        recent={table.recent}
        page="table"
        initial={onTablet ? null : 'chat'}
        chat={<ChatPanel messages={table.chat} onSend={(text) => send({ type: 'chat', text })} />}
        conventions={<BookHints board={board} robotKind={partnerSeat?.robot ? (partnerSeat.robotKind ?? 'tku') : 'tku'} />}
      />
    </Layout>
  )
}
