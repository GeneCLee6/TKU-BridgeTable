import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, SEATS, sideOf, type Seat } from '../../shared/cards.ts'
import { isRobotId, type BoardView, type TableView } from '../../shared/protocol.ts'
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
import { Button, Muted, PageMain } from '../components/ui.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { seatLetter } from '../strings.ts'

/**
 * The table, laid out like BBO: green felt, the viewer's seat always at the bottom, partner on
 * top, opponents left and right. Card sizes follow the size of the felt, so the table fills the
 * window. During the auction each player's calls sit in front of them with the bidding box in the
 * middle; during play the middle shows the trick; at the end, the result.
 */

const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) ${({ theme }) => theme.layout.sidePanelWidth};
  height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
`

const Felt = styled.div<{ $phone: boolean }>`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  grid-template-areas:
    'info top status'
    'left center right'
    'box box box'
    'bottom bottom bottom';
  gap: 6px 12px;
  min-height: 0;
  overflow: auto;
  padding: 10px 16px 12px;
  background: radial-gradient(ellipse at center, ${({ theme }) => theme.table.felt} 55%, ${({ theme }) => theme.table.feltEdge});
  color: ${({ theme }) => theme.table.feltText};

  ${({ $phone }) =>
    $phone &&
    css`
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      grid-template-areas:
        'info info status'
        'top top top'
        'left center right'
        'box box box'
        'bottom bottom bottom';
      gap: 6px;
      padding: 8px 8px 12px;
      min-height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});
    `}
`

const Area = styled.div<{ $area: string; $align?: 'start' | 'center' | 'end' }>`
  grid-area: ${({ $area }) => $area};
  display: flex;
  flex-direction: column;
  align-items: ${({ $align }) => ($align === 'start' ? 'flex-start' : $align === 'end' ? 'flex-end' : 'center')};
  justify-content: center;
  gap: 6px;
  min-width: 0;
`

const Center = styled(Area)`
  position: relative;
  gap: 10px;
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



const Waiting = styled.div`
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: 16px;
  font-weight: 600;
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
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
`




const TableTitle = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 700;
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
    const seat = played.at(-1)!.seat
    return seat === me || (board.contract?.declarer === me && seat === board.dummy)
  }
  return board.auction.at(-1)?.seat === me
}

/** Keeps a finished trick on the table for a moment before clearing it, as BBO does */
function useShownTrick(board: BoardView | null, showLast: boolean) {
  const tricks = board?.tricks ?? []
  const current = tricks.at(-1)
  const completed = tricks.filter((t) => t.winner).length
  // How many completed tricks have already been cleared from the table
  const [cleared, setCleared] = useState(0)

  useEffect(() => {
    const timer = setTimeout(() => setCleared(completed), 1400)
    return () => clearTimeout(timer)
  }, [completed])

  if (showLast) return tricks.findLast((t) => t.winner) ?? null
  if (!current) return null
  if (current.winner && (cleared >= completed || board?.phase !== 'play')) return null
  return current
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

/** Card widths for each part of the table */
function cardSizes(width: number, height: number) {
  const phone = width < 700
  if (phone) {
    const bottom = clamp(44, width * 0.155, 84)
    return { phone, bottom, top: clamp(36, bottom * 0.8, 70), side: clamp(30, width * 0.11, 50), trick: clamp(40, bottom * 0.78, 70) }
  }
  const bottom = clamp(56, Math.min(width * 0.085, height * 0.13), 124)
  return {
    phone,
    bottom,
    top: Math.round(bottom * 0.82),
    side: Math.round(bottom * 0.74),
    trick: Math.round(bottom * 0.88),
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
  const { cardStyle } = usePreferences()
  const [feltRef, feltSize] = useSize()
  const sizes = cardSizes(feltSize.width, feltSize.height)
  const board = table.board
  // Toggles that belong to one board are stored with its number, so they reset on the next deal
  const boardNo = board?.boardNo ?? 0
  const [auctionFor, setAuctionFor] = useState(0)
  const [lastTrickFor, setLastTrickFor] = useState(0)
  const [claimingFor, setClaimingFor] = useState(0)
  const showAuction = auctionFor === boardNo
  const showLast = lastTrickFor === boardNo
  const claiming = claimingFor === boardNo

  const me = table.mySeat
  const viewer = me ?? 'S'
  const at = rotation(viewer)
  const positionOf = (seat: Seat) => (Object.keys(at) as Position[]).find((p) => at[p] === seat)!
  const shownTrick = useShownTrick(board, showLast)
  const nameOf = (seat: Seat) => {
    const o = table.seats[seat]
    return o ? (o.robot ? `${t.robot} ${seatLetter[seat]}` : o.username) : seatLetter[seat]
  }
  const people = SEATS.filter((s) => table.seats[s] && !isRobotId(table.seats[s]!.id))
  const missing = SEATS.filter((s) => !table.seats[s]).length

  const seatParts = (position: Position) => {
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
    const plate = (
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
    )
    const width = position === 'bottom' ? sizes.bottom : side ? sizes.side : sizes.top
    const hand = board && (
      <HandView
        cards={cards}
        count={board.handCounts[seat]}
        width={width}
        style={cardStyle}
        orientation={side && sizes.phone && cardStyle === 'cards' ? 'vertical' : 'horizontal'}
        playable={board.turn === seat ? board.legalCards : []}
        onPlay={(card) => send({ type: 'play', card })}
        label={`${seatLetter[seat]} ${nameOf(seat)}`}
      />
    )
    return { plate, hand }
  }

  const seatArea = (position: Position) => {
    const { plate, hand } = seatParts(position)
    return (
      <Area $area={position}>
        {plate}
        {hand}
      </Area>
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

  const auctionCenter = (b: BoardView) => {
    const myCall = b.legalCalls.length > 0 && !b.undo
    const names = Object.fromEntries(SEATS.map((seat) => [seat, nameOf(seat)])) as Record<Seat, string>
    return (
      <>
        <AuctionBox
          auction={b.auction}
          dealer={b.dealer}
          vul={b.vul}
          viewer={viewer}
          turn={b.turn}
          names={names}
          size={sizes.phone ? 60 : Math.round(sizes.bottom * 1.05)}
        />
        <Waiting>{b.turn && !myCall ? t.waitingFor(nameOf(b.turn)) : ''}</Waiting>
        {undoPrompt()}
      </>
    )
  }

  const center = () => {
    if (!board)
      return (
        <FeltPanel>
          <div>{t.waitingForPlayers(missing)}</div>
        </FeltPanel>
      )
    if (board.phase === 'auction') return auctionCenter(board)
    if (board.phase === 'finished')
      return (
        <ResultPanel
          board={board}
          seated={me}
          ready={table.ready}
          people={people}
          onReady={() => send({ type: 'ready' })}
          declarerName={board.contract ? nameOf(board.contract.declarer) : undefined}
        />
      )
    return (
      <>
        {shownTrick ? (
          <TrickArea
            cards={shownTrick.cards}
            positionOf={positionOf}
            winner={shownTrick.winner}
            width={sizes.trick}
            label={showLast ? t.lastTrick : t.thisTrick}
          />
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

  const bottom = seatParts('bottom')
  const infoSize = Math.max(20, Math.round(sizes.bottom * 0.3))

  return (
    <Layout>
      <Felt ref={feltRef} $phone={sizes.phone}>
        <Area $area="info" $align="start">
          {board && <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={at} size={infoSize} />}
        </Area>
        <Area $area="status" $align="end">
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
        {seatArea('top')}
        {seatArea('left')}
        <Center $area="center">{center()}</Center>
        {seatArea('right')}
        {board?.phase === 'auction' && board.legalCalls.length > 0 && !board.undo && (
          <Area $area="box">
            <BiddingBox
              legal={board.legalCalls}
              onCall={(call, alert) => send({ type: 'call', call, alert })}
              size={sizes.phone ? 56 : Math.round(sizes.bottom * 0.85)}
            />
          </Area>
        )}
        <Area $area="bottom">
          {bottom.hand}
          {bottom.plate}
          <Actions>
            {!me && <Note>{t.kibitzing}</Note>}
            {board && board.phase === 'play' && (
              <FeltButton
                type="button"
                $tone="plain"
                onClick={() => setLastTrickFor(showLast ? 0 : boardNo)}
                disabled={!board.tricks.some((x) => x.winner)}
              >
                {showLast ? t.hideLastTrick : t.lastTrick}
              </FeltButton>
            )}
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
        header={
          <TableTitle>
            <span>
              {t.tableName(table.number)} · {t.boardsPlayed(table.boardsPlayed)}
            </span>
            <span>
              {me && (
                <Button type="button" $small $variant="ghost" onClick={() => send({ type: 'stand' })}>
                  {t.standUp}
                </Button>
              )}
              <Button type="button" $small $variant="danger" onClick={onLeave}>
                {t.leaveTable}
              </Button>
            </span>
          </TableTitle>
        }
        chat={<ChatPanel messages={table.chat} onSend={(text) => send({ type: 'chat', text })} />}
      />
    </Layout>
  )
}

