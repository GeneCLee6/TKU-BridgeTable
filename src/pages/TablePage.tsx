import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, SEATS, sideOf, suitOf, type Seat, type Suit } from '../../shared/cards.ts'
import type { BoardView, TableView } from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BiddingBox } from '../components/BiddingBox.tsx'
import { BoardInfo } from '../components/BoardInfo.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { HandView } from '../components/HandView.tsx'
import { SeatPlate } from '../components/SeatPlate.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ClaimPicker, FeltButton, FeltPanel, Prompt, ResultPanel } from '../components/TablePanels.tsx'
import { TrickArea, TrickSpace, type Position } from '../components/TrickArea.tsx'
import { TrickPile } from '../components/TrickPile.tsx'
import { Muted, PageMain } from '../components/ui.tsx'
import { suitOrder } from '../lib/cards.ts'
import { auctionBoxHeight, biddingBoxHeight, handHeight, type Orientation } from '../lib/measure.ts'
import { dealSound, playCardSound, unlockSound } from '../lib/sound.ts'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { seatLetter } from '../strings.ts'

/**
 * The table, laid out like BBO: green felt, the viewer's seat always at the bottom, partner on
 * top, opponents left and right, every hand drawn above its name plate. Card sizes follow the size
 * of the felt, so the table fills the window. During the auction the middle holds the auction
 * table with room for the bidding box kept free below it, so neither ever moves or covers the
 * other; during play it holds the trick. Finished tricks go face down to the bottom-left corner;
 * undo and claim sit in the bottom-right one.
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

const Felt = styled.div<{ $phone: boolean }>`
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

  ${({ $phone }) =>
    $phone &&
    css`
      grid-template-columns: auto minmax(0, 1fr) auto;
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

/**
 * A hand with its name plate below. On a computer the plate runs the width of the hand and covers
 * the foot of the cards, as BBO's name bar does; the rank and suit stay visible at the top.
 */
const SeatBlock = styled.div<{ $overlap: number }>`
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  max-width: 100%;
  & > [data-plate] {
    position: relative;
    z-index: 2;
    display: flex;
    justify-content: center;
    margin-top: -${({ $overlap }) => $overlap}px;
    ${({ $overlap }) => $overlap > 0 && '& > * { flex: 1 1 auto; }'}
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
  display: grid;
  gap: 6px;
  justify-items: start;
  font-size: 14px;
  font-weight: 700;
  color: ${({ theme }) => theme.table.feltText};

  & > div { display: flex; flex-wrap: wrap; gap: 6px; }
  & button { min-height: 32px; padding: 0 12px; font-size: 14px; }
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

/** Whether `me` may ask to take back the most recent call or card */
function canUndo(board: BoardView, me: Seat | null) {
  if (!me || board.phase === 'finished' || board.claim || board.undo) return false
  const played = board.tricks.flatMap((t) => t.cards)
  if (played.length) {
    // Dummy's cards belong to the declarer, as on the server
    const seat = played.at(-1)!.seat
    return seat === board.dummy ? board.contract?.declarer === me : seat === me
  }
  return board.auction.at(-1)?.seat === me
}

/** Keeps a finished trick on the table for a moment before it goes to the pile, as BBO does */
function useShownTrick(board: BoardView | null) {
  const tricks = board?.tricks ?? []
  const current = tricks.at(-1)
  const completed = tricks.filter((t) => t.winner).length
  // How many completed tricks have already been cleared from the table
  const [cleared, setCleared] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setCleared(completed), 1400)
    return () => clearTimeout(timer)
  }, [completed])

  if (!current) return null
  if (current.winner && (cleared >= completed || board?.phase !== 'play')) return null
  return current
}

/** Plays BBO's sounds: a riffle when a board is dealt, a snap for every card played */
function useTableSounds(board: BoardView | null, on: boolean) {
  const boardNo = board?.boardNo ?? 0
  const played = board ? board.tricks.reduce((n, t) => n + t.cards.length, 0) : 0
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
 */
function tableSizes(feltWidth: number, feltHeight: number) {
  const phone = feltWidth < 700
  if (phone) {
    const bottom = clamp(44, feltWidth * 0.155, 84)
    return {
      phone,
      bottom,
      top: clamp(36, bottom * 0.8, 70),
      side: clamp(30, feltWidth * 0.11, 50),
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
  const parts = (w: number) => {
    const top = Math.round(w * 0.85)
    const side = Math.round(w * 0.8)
    const auction = Math.round(w * AUCTION_SCALE)
    const box = Math.round(w * BOX_SCALE)
    const middle = Math.max(auctionBoxHeight(auction, AUCTION_ROWS) + STACK_GAP + biddingBoxHeight(box), handHeight(side, 'rows'))
    return { top, side, auction, box, tall: handHeight(top, 'horizontal') + middle + handHeight(w, 'horizontal') }
  }
  // Thirteen overlapped cards take about seven card widths, and still read well squeezed to 6.3
  let bottom = 124
  while (bottom > 56 && (parts(bottom).tall > height || bottom * 6.3 > middleWidth)) bottom--
  const { top, side, box } = parts(bottom)
  // If the width set the card size, the auction table takes up the height left over
  const middle = height - handHeight(top, 'horizontal') - handHeight(bottom, 'horizontal') - STACK_GAP - biddingBoxHeight(box)
  let auction = Math.round(bottom * AUCTION_SCALE)
  while (auction < Math.min(bottom * AUCTION_MAX_SCALE, AUCTION_MAX) && auctionBoxHeight(auction + 1, AUCTION_ROWS) <= middle) auction++
  return {
    phone,
    bottom,
    top,
    side,
    trick: Math.round(bottom * 0.88),
    auction,
    auctionRows: AUCTION_ROWS,
    auctionWidth: Math.round(Math.min(middleWidth, auction * 5.2)),
    box,
  }
}

export function TablePage() {
  const { tableId } = useParams()
  const { table, lobby, status, send } = useClub()
  const t = useT()
  const navigate = useNavigate()

  useEffect(() => {
    if (status !== 'open' || !lobby || !tableId) return
    if (lobby.myTableId === tableId || !lobby.tables.some((x) => x.id === tableId)) return
    send({ type: 'joinTable', tableId })
  }, [status, lobby, tableId, send])

  if (!lobby) return <PageMain>{t.connecting}</PageMain>
  if (!lobby.tables.some((x) => x.id === tableId))
    return (
      <PageMain>
        <Muted>{t.tableGone}</Muted>
        <p>
          <Link to="/">{t.navLobby}</Link>
        </p>
      </PageMain>
    )
  if (!table || table.id !== tableId) return <PageMain>{t.loading}</PageMain>

  return (
    <TableScreen
      table={table}
      send={send}
      onLeave={() => {
        send({ type: 'leaveTable' })
        navigate('/')
      }}
    />
  )
}

function TableScreen({
  table,
  send,
  onLeave,
}: {
  table: TableView
  send: ReturnType<typeof useClub>['send']
  onLeave: () => void
}) {
  const t = useT()
  const { cardStyle, sound } = usePreferences()
  const [feltRef, feltSize] = useSize()
  const sizes = tableSizes(feltSize.width, feltSize.height)
  const board = table.board
  // Toggles that belong to one board are stored with its number, so they reset on the next deal
  const boardNo = board?.boardNo ?? 0
  const [auctionFor, setAuctionFor] = useState(0)
  const [lastTrickFor, setLastTrickFor] = useState(0)
  const [claimingFor, setClaimingFor] = useState(0)
  const showAuction = auctionFor === boardNo
  const showLast = lastTrickFor === boardNo
  const claiming = claimingFor === boardNo
  const toggleLast = useCallback(() => setLastTrickFor((n) => (n === boardNo ? 0 : boardNo)), [boardNo])

  const me = table.mySeat
  const viewer = me ?? 'S'
  const at = rotation(viewer)
  const positionOf = (seat: Seat) => (Object.keys(at) as Position[]).find((p) => at[p] === seat)!
  const shownTrick = useShownTrick(board)
  useTableSounds(board, sound)
  const nameOf = (seat: Seat) => {
    const o = table.seats[seat]
    return o ? (o.robot ? `${t.robot} ${seatLetter[seat]}` : o.username) : seatLetter[seat]
  }
  const missing = SEATS.filter((s) => !table.seats[s]).length
  const trump = board?.contract && board.phase !== 'auction' ? board.contract.strain : null

  /** Suits in BBO's order: colours alternate around the suits the hand was dealt, trumps first */
  const orderFor = (seat: Seat, cards: string[]) => {
    const played = board?.tricks.flatMap((x) => x.cards).filter((x) => x.seat === seat).map((x) => x.card) ?? []
    const held = [...new Set([...cards, ...played].map(suitOf))] as Suit[]
    return suitOrder(trump, held)
  }

  const seatBlock = (position: Position) => {
    const seat = at[position]
    const occupant = table.seats[seat]
    const cards = board?.hands[seat] ?? (board?.claim?.seat === seat ? board.claim.hand : undefined)
    const side = position === 'left' || position === 'right'
    const role =
      board?.contract && board.phase !== 'auction'
        ? board.contract.declarer === seat
          ? 'declarer'
          : board.dummy === seat
            ? 'dummy'
            : undefined
        : undefined
    const canSit = (!occupant || occupant.robot) && (!me || !board || board.phase === 'finished')
    const width = position === 'bottom' ? sizes.bottom : side ? sizes.side : sizes.top
    // Face-up hands on the left and right go in rows by suit (BBO's dummy), which is narrow
    const orientation: Orientation = !side ? 'horizontal' : sizes.phone ? 'vertical' : cards ? 'rows' : 'horizontal'
    const hand = board && (
      <HandView
        cards={cards}
        count={board.handCounts[seat]}
        width={width}
        style={cardStyle}
        orientation={orientation}
        order={cards ? orderFor(seat, cards) : undefined}
        playable={board.turn === seat ? board.legalCards : []}
        onPlay={(card) => send({ type: 'play', card })}
        label={`${seatLetter[seat]} ${nameOf(seat)}`}
      />
    )
    const covers = !!hand && !sizes.phone && cardStyle === 'cards'
    return (
      <SeatBlock $overlap={covers ? PLATE : 0}>
        {hand}
        <div data-plate>
          <SeatPlate
            seat={seat}
            occupant={occupant}
            vulnerable={board ? isVulnerable(board.vul, seat) : false}
            turn={!!board && board.turn === seat && board.phase !== 'finished'}
            role={role}
            isMe={seat === me}
            onSit={canSit && !(occupant?.robot && me) ? () => send({ type: 'sit', tableId: table.id, seat }) : undefined}
            onFree={occupant && !occupant.online && seat !== me ? () => send({ type: 'freeSeat', seat }) : undefined}
            onAddRobot={me && !occupant ? () => send({ type: 'addRobot', seat }) : undefined}
            onRemoveRobot={me && occupant?.robot ? () => send({ type: 'removeRobot', seat }) : undefined}
            compact={side && sizes.phone}
          />
        </div>
      </SeatBlock>
    )
  }

  const remaining = board ? 13 - board.tricks.filter((x) => x.winner).length : 0
  const atTrickBoundary = !!board && (board.tricks.length === 0 || !!board.tricks.at(-1)!.winner)
  const canClaim = !!board && board.phase === 'play' && !!me && me !== board.dummy && !board.claim && atTrickBoundary

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
            <BiddingBox legal={b.legalCalls} onCall={(call, alert) => send({ type: 'call', call, alert })} size={sizes.box} />
          )}
    </BoxSlot>
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
    if (board.phase === 'finished')
      return <ResultPanel board={board} declarerName={board.contract ? nameOf(board.contract.declarer) : undefined} />
    return (
      <>
        {shownTrick ? (
          <TrickArea cards={shownTrick.cards} positionOf={positionOf} winner={shownTrick.winner} width={sizes.trick} label={t.thisTrick} />
        ) : (
          <TrickSpace $w={sizes.trick} />
        )}
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
        </Overlay>
      </>
    )
  }

  const infoSize = Math.max(20, Math.round(sizes.bottom * 0.3))

  return (
    <Layout>
      <Felt ref={feltRef} $phone={sizes.phone}>
        <Area $area="info" $align="start" $justify="start">
          <InfoRow>
            {board && <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={at} size={infoSize} />}
            <TableTitle>
              <span>
                {t.tableName(table.number)} · {t.boardsPlayed(table.boardsPlayed)}
              </span>
              <div>
                {me && (
                  <FeltButton type="button" $tone="plain" onClick={() => send({ type: 'stand' })}>
                    {t.standUp}
                  </FeltButton>
                )}
                <FeltButton type="button" $tone="stop" onClick={onLeave}>
                  {t.leaveTable}
                </FeltButton>
              </div>
            </TableTitle>
          </InfoRow>
        </Area>
        <Area $area="status" $align="end" $justify="start">
          {board && board.phase !== 'auction' && (
            <>
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
              {showAuction && <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} viewer={viewer} size={sizes.side} />}
            </>
          )}
        </Area>
        <Area $area="top">{seatBlock('top')}</Area>
        <Area $area="left">{seatBlock('left')}</Area>
        <Center $area="center">{center()}</Center>
        <Area $area="right">{seatBlock('right')}</Area>
        {sizes.phone && board?.phase === 'auction' && <Area $area="box">{biddingSlot(board)}</Area>}
        <Area $area="bottom" $justify="end">
          {seatBlock('bottom')}
        </Area>
        <Area $area="tricks" $align="start" $justify="end">
          {board && board.phase !== 'auction' && (
            <TrickPile
              tricks={board.tricks}
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
            {board && me && canUndo(board, me) && (
              <FeltButton type="button" $tone="plain" onClick={() => send({ type: 'undoRequest' })}>
                {t.undo}
              </FeltButton>
            )}
            {canClaim && (
              <FeltButton type="button" $tone="plain" onClick={() => setClaimingFor(claiming ? 0 : boardNo)}>
                {t.claim}
              </FeltButton>
            )}
          </Actions>
        </Area>
      </Felt>
      <SidePanel
        tabs={['chat', 'people', 'history']}
        recent={table.recent}
        page="table"
        initial="chat"
        chat={<ChatPanel messages={table.chat} onSend={(text) => send({ type: 'chat', text })} />}
      />
    </Layout>
  )
}
