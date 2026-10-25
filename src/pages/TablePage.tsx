import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EyeOff, Lock, Settings } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import styled, { css, keyframes } from 'styled-components'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, partnerOf, SEATS, sideOf, suitOf, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import type { Trick } from '../../shared/game.ts'
import {
  DEAL_COUNTDOWN_MS,
  SLOW_TURN_MS,
  type BoardView,
  type TableView,
} from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BiddingBox, type BiddingHints } from '../components/BiddingBox.tsx'
import { BoardInfo } from '../components/BoardInfo.tsx'
import { ChallengeBanner } from '../components/ChallengeBanner.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { DEAL_MS, DealAnimation } from '../components/DealAnimation.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { HandView } from '../components/HandView.tsx'
import { SeatPlate, type SeatAction } from '../components/SeatPlate.tsx'
import { TableSettingsDialog } from '../components/TableSettingsDialog.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ClaimPicker, FeltButton, FeltPanel, Prompt, ResultPanel } from '../components/TablePanels.tsx'
import { COLLECT_MS, TrickArea, TrickSpace, type CardOrigin, type Position } from '../components/TrickArea.tsx'
import { TrickPile } from '../components/TrickPile.tsx'
import { Muted, PageMain } from '../components/ui.tsx'
import { CARD_SCALE, sortForDisplay, suitOrder } from '../lib/cards.ts'
import { auctionBoxHeight, biddingBoxHeight, handHeight, type Orientation } from '../lib/measure.ts'
import { dealSound, playCardSound, turnSound, unlockSound } from '../lib/sound.ts'
import { useCardChoice } from '../lib/useCardChoice.ts'
import { useRobotRules } from '../lib/useRobotRules.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
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

const Felt = styled.div<{ $phone: boolean; $sides?: number }>`
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

  ${({ $phone, $sides }) =>
    $phone &&
    css`
      /* The turned side seats are the same width, so the middle sits in the middle */
      grid-template-columns: ${$sides ? `${$sides}px minmax(0, 1fr) ${$sides}px` : 'auto minmax(0, 1fr) auto'};
      grid-template-rows: auto auto minmax(0, 1fr) auto auto auto;
      grid-template-areas:
        'info info status'
        'top top top'
        'left center right'
        'box box box'
        'bottom bottom bottom'
        'tricks tricks actions';
      gap: 6px;
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

/** The host's settings button, a small round one on the felt */
const SettingsButton = styled.button`
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
function useTrickTable(board: BoardView | null, holdLast: boolean, leading: boolean) {
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
    const timer = setTimeout(() => setLeaving(null), COLLECT_MS)
    return () => clearTimeout(timer)
  }, [going])

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

/** Plays BBO's sounds: a soft riffle when a board is dealt, a soft knock for every card played */
function useTableSounds(boardNo: number, played: number, on: boolean) {
  const last = useRef({ boardNo, played })

  useEffect(() => {
    // Browsers only allow sound after the page has been used
    window.addEventListener('pointerdown', unlockSound)
    window.addEventListener('keydown', unlockSound)
    return () => {
      window.removeEventListener('pointerdown', unlockSound)
      window.removeEventListener('keydown', unlockSound)
    }
  }, [])

  useEffect(() => {
    const before = last.current
    last.current = { boardNo, played }
    if (!on) return
    if (boardNo && boardNo !== before.boardNo) dealSound()
    else if (played > before.played) playCardSound()
  }, [boardNo, played, on])
}

/**
 * Tells you it is your turn when you are looking elsewhere: a chime when your call comes round (and
 * when your card is due while this tab is in the background), and the tab's title says so too
 */
function useTurnAlert(turn: 'call' | 'play' | null, label: string | null, on: boolean) {
  const last = useRef(turn)
  const baseTitle = useRef(document.title)

  useEffect(() => {
    const before = last.current
    last.current = turn
    if (!on || !turn || turn === before) return
    if (turn === 'call' || document.hidden) turnSound()
  }, [turn, on])

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

/** Scale of the auction table and the bidding box against the viewer's card width */
const AUCTION_SCALE = 0.95
/** When the width sets the card size, the auction table grows into the spare height, up to this */
const AUCTION_MAX_SCALE = 1.3
const AUCTION_MAX = 130
const BOX_SCALE = 0.58
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
    }
  }
  // contentRect excludes the padding; the grid gaps come out of it
  const height = feltHeight - 2 * GAP.row
  const middleWidth = ((feltWidth - 2 * GAP.column) * 2) / 4
  const rows = scale > 1 ? AUCTION_ROWS - 2 : AUCTION_ROWS
  const squeeze = 6.3 / Math.max(1, scale)
  const parts = (w: number) => {
    const top = Math.round(w * 0.85)
    const side = Math.round(w * 0.8)
    const auction = Math.round(w * AUCTION_SCALE)
    const box = Math.round(w * BOX_SCALE)
    const middle = Math.max(auctionBoxHeight(auction, rows) + STACK_GAP + biddingBoxHeight(box), handHeight(side, 'rows'))
    return { top, side, auction, box, tall: handHeight(top, 'horizontal') + middle + handHeight(w, 'horizontal') }
  }
  // Thirteen overlapped cards take about seven card widths, and still read well squeezed to 6.3
  let bottom = Math.round(124 * Math.max(1, scale))
  while (bottom > 56 && (parts(bottom).tall > height || bottom * squeeze > middleWidth)) bottom--
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
  }
}

export function TablePage() {
  const { tableId } = useParams()
  const { table, lobby, status, send } = useClub()
  const t = useT()

  // An invite table takes only the invited, and a table without kibitzers takes people only into its seats
  const summary = lobby?.tables.find((x) => x.id === tableId)
  const closed = !!summary && lobby?.myTableId !== tableId && (!summary.welcome || !summary.settings.allowKibitz)

  useEffect(() => {
    if (status !== 'open' || !lobby || !tableId || closed) return
    if (lobby.myTableId === tableId || !lobby.tables.some((x) => x.id === tableId)) return
    send({ type: 'joinTable', tableId })
  }, [status, lobby, tableId, send, closed])

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
  if (lobby.myTableId !== tableId && !lobby.tables.some((x) => x.id === tableId))
    return (
      <PageMain>
        <Muted>{t.tableGone}</Muted>
        <p>
          <Link to="/">{t.navLobby}</Link>
        </p>
      </PageMain>
    )
  if (closed)
    return (
      <PageMain>
        <Muted>{summary.welcome ? t.noKibitzTable : t.notInvitedTable}</Muted>
        <p>
          <Link to="/">{t.navLobby}</Link>
        </p>
      </PageMain>
    )
  if (!table || table.id !== tableId) return <PageMain>{t.loading}</PageMain>

  return <TableScreen table={table} send={send} />
}

function TableScreen({ table, send }: { table: TableView; send: ReturnType<typeof useClub>['send'] }) {
  const t = useT()
  const { cardStyle, sound, lang, confirmCalls, confirmPlays, cardSize } = usePreferences()
  const { user } = useAuth()
  const { error, lobby } = useClub()
  const [feltRef, feltSize] = useSize()
  const sizes = tableSizes(feltSize.width, feltSize.height, CARD_SCALE[cardSize])
  const board = table.board
  // Toggles that belong to one board are stored with its number, so they reset on the next deal
  const boardNo = board?.boardNo ?? 0
  const [auctionFor, setAuctionFor] = useState(0)
  const [lastTrickFor, setLastTrickFor] = useState(0)
  const [claimingFor, setClaimingFor] = useState(0)
  const [editingSettings, setEditingSettings] = useState(false)
  const showAuction = auctionFor === boardNo
  const showLast = lastTrickFor === boardNo
  const claiming = claimingFor === boardNo
  const toggleLast = useCallback(() => setLastTrickFor((n) => (n === boardNo ? 0 : boardNo)), [boardNo])

  const me = table.mySeat
  const challenge = table.challenge
  // Nobody runs a challenge table: its seats, robots and settings are fixed
  const iAmHost = !!user && table.hostId === user.id && !challenge
  const viewer = me ?? 'S'
  const at = rotation(viewer)
  const positionOf = (seat: Seat) => (Object.keys(at) as Position[]).find((p) => at[p] === seat)!
  const nameOf = (seat: Seat) => {
    const o = table.seats[seat]
    return o ? (o.robot ? `${playerName(t, o)} ${seatLetter[seat]}` : o.username) : seatLetter[seat]
  }
  const missing = SEATS.filter((s) => !table.seats[s]).length

  // A robot partner: the bidding box tells how it will read each call, as GIB does on BBO
  const partner = me ? table.seats[partnerOf(me)] : null
  const hinting = !!board && board.legalCalls.length > 0 && !!partner?.robot
  const rules = useRobotRules(hinting)
  const hints = useMemo((): BiddingHints | null => {
    if (!hinting || !rules || !board || !partner) return null
    const meanings = rules.explain(rules.ROBOT_SYSTEMS[partner.robotKind ?? 'tku'], board.auction, board.dealer, board.vul)
    return {
      title: t.robotReads(playerName(t, partner)),
      text: (call) => {
        const spec = meanings.get(call)
        return (spec && rules.describe(spec, lang)) || t.noRobotMeaning
      },
    }
  }, [hinting, rules, board, partner, t, lang])
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
    const timer = setTimeout(() => setDealing(0), DEAL_MS + 450)
    return () => clearTimeout(timer)
  }, [dealing])
  useTableSounds(boardNo, playedCount, sound)
  const myTurn =
    board?.phase === 'auction' && board.legalCalls.length > 0 && !board.undo
      ? 'call'
      : board?.phase === 'play' && board.legalCards.length > 0 && !board.claim
        ? 'play'
        : null
  useTurnAlert(myTurn, myTurn === 'call' ? t.yourCall : myTurn === 'play' ? t.yourPlay : null, sound)
  const slowSeat = useSlowSeat(table.waiting)
  // A minute on one call or card: the player hears the chime again
  useEffect(() => {
    if (sound && slowSeat && slowSeat === me) turnSound()
  }, [slowSeat, me, sound])

  // ── After the board: the last trick stays, then a countdown to the next deal ──
  const finished = board?.phase === 'finished'
  const now = useClock(finished && table.dealAt !== null)
  const toDeal = finished && table.dealAt !== null ? table.dealAt - now : null
  const playedOut = finished && board!.tricks.length === 13 && !!board!.tricks[12].winner && !board!.result?.claimed
  const holdLast = playedOut && toDeal !== null && toDeal > DEAL_COUNTDOWN_MS
  const seconds = toDeal === null ? null : Math.max(1, Math.ceil(Math.min(toDeal, DEAL_COUNTDOWN_MS) / 1000))

  const leadingNow = !!pendingShown && (!board?.tricks.length || !!board.tricks.at(-1)!.winner)
  const trickTable = useTrickTable(board, holdLast, leadingNow)
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

  /** What the viewer may do with a seat: sit there, and for the host: robots and asking people to leave */
  const seatActions = (seat: Seat): SeatAction[] => {
    const occupant = table.seats[seat]
    const actions: SeatAction[] = []
    if (challenge) return actions
    const between = !board || board.phase === 'finished'
    // A free seat (or a robot's) can be taken; someone already seated moves only between boards
    if ((!occupant || (occupant.robot && !me)) && (!me || between))
      actions.push({ label: t.takeSeat(seatLetter[seat]), onSelect: () => send({ type: 'sit', tableId: table.id, seat }) })
    // The host seats TKB in the club's system or in 2/1 (GIB-compatible)
    if (iAmHost && !occupant)
      for (const kind of ['tku', 'gib'] as const) actions.push({ label: t.addRobots[kind], onSelect: () => send({ type: 'addRobot', seat, kind }) })
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
    const width = position === 'bottom' ? sizes.bottom : side ? sizes.side : sizes.top
    // On a phone the side seats lie on their side (cards only; text hands stay as they are)
    const turned = side && turnedSides
    // Face-up hands on the left and right go in rows by suit (BBO's dummy), which is narrow
    const orientation: Orientation = !side || turned ? 'horizontal' : sizes.phone ? 'vertical' : cards ? 'rows' : 'horizontal'
    const hand = board && (
      <div data-hand={seat} data-hand-at={position}>
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
    const cover = !hand || cardStyle !== 'cards' ? 0 : !sizes.phone ? PLATE : turned ? PHONE_COVER : 0
    const block = (
      <SeatBlock
        $overlap={cover}
        $appear={dealing === boardNo && dealing > 0}
        $size={turned ? { width: sizes.sideLength, height: sizes.sideThick } : undefined}
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
      <Turned $thick={sizes.sideThick} $length={sizes.sideLength} $dir={position === 'left' ? 1 : -1}>
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
    <BoxSlot $h={biddingBoxHeight(sizes.box)}>
      {b.undo
        ? undoPrompt()
        : b.legalCalls.length > 0 && (
            <BiddingBox
              legal={b.legalCalls}
              onCall={(call, alert) => send({ type: 'call', call, alert })}
              size={sizes.box}
              hints={hints}
              confirm={confirmCalls}
            />
          )}
    </BoxSlot>
  )

  const trickView = (trick: Trick | null) =>
    trick || trickTable.leaving ? (
      <TrickArea
        cards={trick?.cards ?? []}
        positionOf={positionOf}
        winner={trick?.winner}
        width={sizes.trick}
        label={t.thisTrick}
        origin={origin}
        leaving={trickTable.leaving}
      />
    ) : (
      <TrickSpace $w={sizes.trick} />
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
      <Felt ref={feltRef} $phone={sizes.phone} $sides={turnedSides ? sizes.sideThick : undefined} onClick={trickTable.collect}>
        {dealing > 0 && dealing === boardNo && (
          <DealAnimation key={dealing} felt={feltRef} width={Math.round(sizes.side * 0.8)} />
        )}
        <Area $area="info" $align="start" $justify="start">
          <InfoRow>
            {board && <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={at} size={infoSize} />}
            <TableTitle>
              {challenge ? (
                <ChallengeBanner challenge={challenge} />
              ) : (
                <>
                  <span>
                    {t.tableName(table.number)} · {t.boardsPlayed(table.boardsPlayed)}
                  </span>
                  {table.settings.visibility === 'invite' && <Lock size={15} aria-label={t.inviteOnly} role="img" />}
                  {!table.settings.allowKibitz && <EyeOff size={15} aria-label={t.noKibitz} role="img" />}
                </>
              )}
              {iAmHost && (
                <SettingsButton
                  type="button"
                  aria-label={t.tableSettings}
                  title={t.tableSettings}
                  onClick={(event) => {
                    event.stopPropagation()
                    setEditingSettings(true)
                  }}
                >
                  <Settings size={16} aria-hidden />
                </SettingsButton>
              )}
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
                aria-label={t.showAuction}
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
        <Center $area="center" data-center>
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
        <Area $area="actions" $align="end" $justify="end">
          <Actions>
            {!me && <Note>{t.kibitzing}</Note>}
            {swapNotice && <Note role="status">{t.swappedToDeclare}</Note>}
            {challenge && challenge.played >= challenge.boards && board?.phase === 'finished' && (
              <Note role="status">
                {t.challengeAllDone} <Link to="/">{t.navLobby}</Link>
              </Note>
            )}
            {board && me && board.phase !== 'finished' && (
              <>
                <FeltButton
                  type="button"
                  $tone="plain"
                  disabled={!canUndo}
                  title={challenge ? t.challengeNoUndo : undefined}
                  onClick={() => send({ type: 'undoRequest' })}
                >
                  {t.undo}
                </FeltButton>
                <FeltButton
                  type="button"
                  $tone="plain"
                  disabled={!canClaim}
                  aria-expanded={claiming && canClaim}
                  onClick={() => setClaimingFor(claiming ? 0 : boardNo)}
                >
                  {t.claim}
                </FeltButton>
              </>
            )}
          </Actions>
        </Area>
      </Felt>
      {editingSettings && iAmHost && (
        <TableSettingsDialog
          title={t.tableSettings}
          submitLabel={t.save}
          initial={table.settings}
          members={(lobby?.members ?? []).filter((m) => m.id !== user?.id && !lobby?.blocked.includes(m.id))}
          invited={table.invited?.map((u) => u.id) ?? []}
          onClose={() => setEditingSettings(false)}
          onSubmit={(settings, invitees) => {
            setEditingSettings(false)
            // A public table keeps its invitation list for when it is made invite only again
            send({ type: 'updateTableSettings', settings, ...(settings.visibility === 'invite' && { invitees }) })
          }}
        />
      )}
      <SidePanel
        tabs={['chat', 'people', 'messages', 'history']}
        recent={table.recent}
        page="table"
        initial="chat"
        chat={<ChatPanel messages={table.chat} onSend={(text) => send({ type: 'chat', text })} />}
      />
    </Layout>
  )
}
