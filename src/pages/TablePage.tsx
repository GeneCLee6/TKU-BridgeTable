import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { isVulnerable } from '../../shared/board.ts'
import { nextSeat, sideOf, type Seat } from '../../shared/cards.ts'
import type { BoardView, TableView } from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BiddingBox } from '../components/BiddingBox.tsx'
import { BoardInfo } from '../components/BoardInfo.tsx'
import { ChatPanel } from '../components/ChatPanel.tsx'
import { HandView } from '../components/HandView.tsx'
import { SeatPlate } from '../components/SeatPlate.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ClaimPicker, FeltButton, FeltPanel, Prompt, ResultPanel } from '../components/TablePanels.tsx'
import { TrickArea, type Position } from '../components/TrickArea.tsx'
import { Button, Muted, PageMain } from '../components/ui.tsx'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useClub } from '../state/ClubContext.tsx'
import { mobile, mobileQuery } from '../styles/tokens.ts'
import { seatLetter, strings } from '../strings.ts'

/**
 * The table, laid out like BBO: green felt, the viewer's seat always at the bottom, partner on
 * top, opponents left and right. The middle shows the auction and bidding box, then the trick
 * being played, then the result. Chat and the people at the table sit in a side panel.
 */

const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) ${({ theme }) => theme.layout.sidePanelWidth};
  min-height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Felt = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto;
  grid-template-areas:
    'info top status'
    'left center right'
    'bottom bottom bottom';
  gap: 8px 12px;
  padding: 12px 16px 16px;
  background: radial-gradient(ellipse at center, ${({ theme }) => theme.table.felt} 55%, ${({ theme }) => theme.table.feltEdge});
  color: ${({ theme }) => theme.table.feltText};

  ${mobile} {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: auto;
    grid-template-areas:
      'info status'
      'top top'
      'left right'
      'center center'
      'bottom bottom';
    padding: 8px 12px 12px;
  }
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
  justify-content: center;
  min-height: 240px;
  gap: 10px;
`

const ContractBox = styled.button`
  display: grid;
  gap: 2px;
  min-width: 120px;
  padding: 6px 10px;
  border: 0;
  border-radius: 6px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: 14px;
  text-align: left;

  & > strong { font-size: 18px; }
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 4px;
`

const Side = styled.aside`
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};

  ${mobile} {
    border-left: 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
    min-height: 320px;
  }
`

const Tabs = styled.div`
  display: flex;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`

const Tab = styled.button<{ $active: boolean }>`
  flex: 1;
  min-height: 42px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: none;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
  ${({ $active, theme }) =>
    $active &&
    css`
      color: ${theme.colors.primary};
      border-bottom-color: ${theme.colors.primary};
    `}
`

const TableTitle = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 700;
`

const PeopleList = styled.ul`
  margin: 0;
  padding: 8px 16px;
  list-style: none;
  font-size: 15px;
  line-height: 2;
`

const Note = styled.div`
  color: ${({ theme }) => theme.table.feltMuted};
  font-size: 14px;
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

export function TablePage() {
  const { tableId } = useParams()
  const { table, lobby, status, send } = useClub()
  const navigate = useNavigate()

  useEffect(() => {
    if (status !== 'open' || !lobby || !tableId) return
    if (lobby.myTableId === tableId || !lobby.tables.some((t) => t.id === tableId)) return
    send({ type: 'joinTable', tableId })
  }, [status, lobby, tableId, send])

  if (!lobby) return <PageMain>{strings.connecting}</PageMain>
  if (!lobby.tables.some((t) => t.id === tableId))
    return (
      <PageMain>
        <Muted>找不到這張牌桌，可能已經關閉。</Muted>
        <p>
          <Link to="/">{strings.navLobby}</Link>
        </p>
      </PageMain>
    )
  if (!table || table.id !== tableId) return <PageMain>{strings.loading}</PageMain>

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
  const isPhone = useMediaQuery(mobileQuery)
  const [tab, setTab] = useState<'chat' | 'people'>('chat')
  const board = table.board
  // Toggles that belong to one board are stored with its number, so they reset on the next deal
  const boardNo = board?.boardNo ?? 0
  const [auctionFor, setAuctionFor] = useState(0)
  const [lastTrickFor, setLastTrickFor] = useState(0)
  const [claimingFor, setClaimingFor] = useState(0)
  const showAuction = auctionFor === boardNo
  const showLast = lastTrickFor === boardNo
  const claiming = claimingFor === boardNo
  const setShowAuction = (on: boolean) => setAuctionFor(on ? boardNo : 0)
  const setShowLast = (on: boolean) => setLastTrickFor(on ? boardNo : 0)
  const setClaiming = (on: boolean) => setClaimingFor(on ? boardNo : 0)

  const me = table.mySeat
  const at = rotation(me ?? 'S')
  const positionOf = (seat: Seat) => (Object.keys(at) as Position[]).find((p) => at[p] === seat)!
  const shownTrick = useShownTrick(board, showLast)

  const nameOf = (seat: Seat) => table.seats[seat]?.username ?? seatLetter[seat]
  const missing = (['N', 'E', 'S', 'W'] as Seat[]).filter((s) => !table.seats[s]).length

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
    const plate = (
      <SeatPlate
        seat={seat}
        occupant={occupant}
        vulnerable={board ? isVulnerable(board.vul, seat) : false}
        turn={!!board && board.turn === seat && board.phase !== 'finished'}
        role={role}
        isMe={seat === me}
        onSit={!occupant && (!me || !board || board.phase === 'finished') ? () => send({ type: 'sit', tableId: table.id, seat }) : undefined}
        onFree={occupant && !occupant.online && seat !== me ? () => send({ type: 'freeSeat', seat }) : undefined}
      />
    )
    const hand = board && (
      <HandView
        cards={cards}
        count={board.handCounts[seat]}
        layout={side && isPhone ? 'rows' : 'fan'}
        size={position === 'bottom' ? (isPhone ? 'md' : 'lg') : side || isPhone ? 'sm' : 'md'}
        playable={board.turn === seat ? board.legalCards : []}
        onPlay={(card) => send({ type: 'play', card })}
        label={`${seatLetter[seat]} ${occupant?.username ?? ''}`}
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

  const remaining = board ? 13 - board.tricks.filter((t) => t.winner).length : 0
  const atTrickBoundary = !!board && (board.tricks.length === 0 || !!board.tricks.at(-1)!.winner)
  const canClaim =
    !!board && board.phase === 'play' && !!me && me !== board.dummy && !board.claim && atTrickBoundary

  const center = () => {
    if (!board)
      return (
        <FeltPanel>
          <div>{strings.waitingForPlayers(missing)}</div>
        </FeltPanel>
      )
    if (board.phase === 'auction')
      return (
        <>
          <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} turn={board.turn} />
          {board.legalCalls.length > 0 && !board.undo && (
            <BiddingBox legal={board.legalCalls} onCall={(call, alert) => send({ type: 'call', call, alert })} />
          )}
          {undoPrompt()}
        </>
      )
    if (board.phase === 'finished')
      return (
        <ResultPanel
          board={board}
          seated={me}
          ready={table.ready}
          onReady={() => send({ type: 'ready' })}
          declarerName={board.contract ? nameOf(board.contract.declarer) : undefined}
        />
      )
    return (
      <>
        {shownTrick && (
          <TrickArea
            cards={shownTrick.cards}
            positionOf={positionOf}
            winner={shownTrick.winner}
            size={isPhone ? 'sm' : 'md'}
            label={showLast ? strings.lastTrick : strings.tricks}
          />
        )}
        {!shownTrick && <TrickPlaceholder $phone={isPhone} />}
        {claiming && canClaim && (
          <ClaimPicker
            remaining={remaining}
            onClaim={(tricks) => {
              send({ type: 'claim', tricks })
              setClaiming(false)
            }}
            onCancel={() => setClaiming(false)}
          />
        )}
        {claimPrompt()}
        {undoPrompt()}
      </>
    )
  }

  const claimPrompt = () => {
    const claim = board?.claim
    if (!claim) return null
    const text = strings.claimBy(nameOf(claim.seat), claim.tricks)
    const waiting = claim.approvers.length - claim.accepted.length
    if (me && claim.approvers.includes(me) && !claim.accepted.includes(me))
      return (
        <Prompt
          text={text}
          yes={strings.accept}
          no={strings.reject}
          onAnswer={(accept) => send({ type: 'claimRespond', accept })}
        />
      )
    return <Prompt text={text} detail={strings.claimWaiting(waiting)} />
  }

  const undoPrompt = () => {
    const undo = board?.undo
    if (!undo) return null
    if (me && sideOf(me) !== sideOf(undo.seat))
      return (
        <Prompt
          text={strings.undoBy(nameOf(undo.seat))}
          yes={strings.agree}
          no={strings.reject}
          onAnswer={(accept) => send({ type: 'undoRespond', accept })}
        />
      )
    return <Prompt text={me === undo.seat ? strings.undoRequested : strings.undoBy(nameOf(undo.seat))} />
  }

  return (
    <Layout>
      <Felt>
        <Area $area="info" $align="start">
          {board && <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={at} />}
        </Area>
        <Area $area="status" $align="end">
          {board && board.phase !== 'auction' && (
            <>
              <ContractBox type="button" onClick={() => setShowAuction(!showAuction)} aria-expanded={showAuction} aria-label={strings.showAuction}>
                <strong>
                  <ContractLabel contract={board.contract} onCard />
                </strong>
                <span>
                  NS {board.tricksWon.NS} · EW {board.tricksWon.EW}
                </span>
              </ContractBox>
              {showAuction && <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} />}
            </>
          )}
        </Area>
        {seatArea('top')}
        {seatArea('left')}
        <Center $area="center">{center()}</Center>
        {seatArea('right')}
        <Area $area="bottom">
          {seatParts('bottom').hand}
          {seatParts('bottom').plate}
          <Actions>
            {!me && <Note>{strings.kibitzing}</Note>}
            {board && board.phase === 'play' && (
              <FeltButton type="button" $tone="plain" onClick={() => setShowLast(!showLast)} disabled={!board.tricks.some((t) => t.winner)}>
                {showLast ? strings.hideLastTrick : strings.lastTrick}
              </FeltButton>
            )}
            {board && me && canUndo(board, me) && (
              <FeltButton type="button" $tone="plain" onClick={() => send({ type: 'undoRequest' })}>
                {strings.undo}
              </FeltButton>
            )}
            {canClaim && (
              <FeltButton type="button" $tone="plain" onClick={() => setClaiming(!claiming)}>
                {strings.claim}
              </FeltButton>
            )}
          </Actions>
        </Area>
      </Felt>
      <Side>
        <TableTitle>
          <span>
            {strings.tableName(table.number)} · {strings.boardsPlayed(table.boardsPlayed)}
          </span>
          <span>
            {me && (
              <Button type="button" $small $variant="ghost" onClick={() => send({ type: 'stand' })}>
                {strings.standUp}
              </Button>
            )}
            <Button type="button" $small $variant="danger" onClick={onLeave}>
              {strings.leaveTable}
            </Button>
          </span>
        </TableTitle>
        <Tabs role="tablist">
          <Tab type="button" role="tab" aria-selected={tab === 'chat'} $active={tab === 'chat'} onClick={() => setTab('chat')}>
            {strings.chat}
          </Tab>
          <Tab type="button" role="tab" aria-selected={tab === 'people'} $active={tab === 'people'} onClick={() => setTab('people')}>
            {strings.people}
          </Tab>
        </Tabs>
        {tab === 'chat' ? (
          <ChatPanel messages={table.chat} onSend={(text) => send({ type: 'chat', text })} />
        ) : (
          <PeopleList>
            {(['N', 'E', 'S', 'W'] as Seat[]).map((seat) => (
              <li key={seat}>
                {seatLetter[seat]}：{table.seats[seat]?.username ?? strings.emptySeat}
                {table.seats[seat] && !table.seats[seat]!.online && `（${strings.offline}）`}
              </li>
            ))}
            <li>
              {strings.spectatorsTitle}：
              {table.spectators.length ? table.spectators.map((u) => u.username).join('、') : strings.noSpectators}
            </li>
          </PeopleList>
        )}
      </Side>
    </Layout>
  )
}

const TrickPlaceholder = styled.div<{ $phone: boolean }>`
  width: ${({ $phone }) => ($phone ? 150 : 190)}px;
  height: ${({ $phone }) => ($phone ? 150 : 190)}px;
  border-radius: 50%;
  border: 2px dashed rgba(255, 255, 255, 0.12);
`
