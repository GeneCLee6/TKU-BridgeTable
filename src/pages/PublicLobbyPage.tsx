import { useCallback, useEffect, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { useParams } from 'react-router-dom'
import styled from 'styled-components'
import { SEATS } from '../../shared/cards.ts'
import { GUEST_POLL_MS, type GuestSeat, type GuestTable, type PublicTable } from '../../shared/public-lobby.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { RecordDiagram } from '../components/RecordDiagram.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ActionLink, Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { CARD_SCALE } from '../lib/cards.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { vugraphRecord } from '../lib/vugraph.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobileQuery } from '../styles/tokens.ts'

/**
 * The cross-club lobby (e12-t07, ARCHITECTURE.md §1「跨社團大廳」): the tables other clubs opened to
 * every club, and one of them watched as a guest. Watching only: the server sends names and the
 * board as any spectator sees it, never a member id, the chat or a way to sit. Behind the
 * `publicLobby` flag; the Worker answers from every club (`worker/routing.ts`).
 */

const List = styled.ul`
  display: grid;
  gap: 12px;
  max-width: 900px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Row = styled(Card)`
  display: grid;
  gap: 6px;

  & > h2 {
    margin: 0;
    font-size: 17px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Seats = styled.p`
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
`

const Actions = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`

const Head = styled.div`
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
`

const Board = styled(Card)`
  display: grid;
  gap: 10px;
  max-width: 640px;
`

const Line = styled.p`
  margin: 0;
  font-weight: 600;
`

function SeatNames({ seats }: { seats: Record<string, GuestSeat | null> }) {
  const { t } = usePreferences()
  return (
    <Seats>
      {SEATS.map((seat) => (
        <span key={seat}>
          {t.seatNames[seat]} {seats[seat]?.username ?? t.clubs.emptySeat}
        </span>
      ))}
    </Seats>
  )
}

export function PublicLobbyPage() {
  const { t, message } = usePreferences()
  const [tables, setTables] = useState<PublicTable[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api
      .publicLobby()
      .then((lobby) => {
        setTables(lobby.tables)
        setError('')
      })
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [message])
  useEffect(load, [load])

  return (
    <PageMain>
      <PageTitle>{t.clubs.lobbyTitle}</PageTitle>
      <Head>
        <Muted>{t.clubs.lobbyIntro}</Muted>
        <Actions>
          <Button type="button" onClick={load}>
            <RefreshCw size={16} aria-hidden />
            {t.clubs.refresh}
          </Button>
        </Actions>
        {error && <ErrorText role="alert">{error}</ErrorText>}
      </Head>
      {tables === null ? (
        !error && <Muted>{t.loading}</Muted>
      ) : tables.length === 0 ? (
        <Muted>{t.clubs.lobbyEmpty}</Muted>
      ) : (
        <List>
          {tables.map((table) => (
            <li key={`${table.clubId}/${table.tableId}`}>
              <Row aria-label={t.clubs.tableOf(table.clubName, table.number)}>
                <h2>{t.clubs.tableOf(table.clubName, table.number)}</h2>
                <SeatNames seats={table.seats} />
                <Muted>
                  {table.playing ? t.clubs.playing : t.clubs.waiting} · {t.clubs.boardsPlayed(table.boardsPlayed)}
                </Muted>
                <Actions>
                  <ActionLink to={`/clubs/${encodeURIComponent(table.clubId)}/${encodeURIComponent(table.tableId)}`}>
                    <Eye size={16} aria-hidden />
                    {t.clubs.watch}
                  </ActionLink>
                </Actions>
              </Row>
            </li>
          ))}
        </List>
      )}
    </PageMain>
  )
}

/** One table of another club, watched as a guest: asked for again every few seconds, not while the tab is hidden */
export function GuestTablePage() {
  const { clubId = '', tableId = '' } = useParams()
  const { t, message, cardStyle, cardSize } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const [table, setTable] = useState<GuestTable | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(load, GUEST_POLL_MS)
        return
      }
      api
        .guestTable(clubId, tableId)
        .then(({ table }) => {
          if (!live) return
          setTable(table)
          setError('')
          timer = setTimeout(load, GUEST_POLL_MS)
        })
        .catch((e) => {
          if (!live) return
          setTable(null)
          setError(e.code === 'tableGone' ? t.clubs.guestGone : message(e.code, e.params, e.message))
        })
    }
    load()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [clubId, tableId, message, t])

  const back = (
    <ActionLink back to="/clubs">
      {t.clubs.back}
    </ActionLink>
  )
  if (error)
    return (
      <PageMain>
        {back}
        <ErrorText role="alert">{error}</ErrorText>
      </PageMain>
    )
  if (!table) return <PageMain>{t.loading}</PageMain>
  const scale = CARD_SCALE[cardSize]
  const record = vugraphRecord(table)
  const side = (seat: string) => seat === 'E' || seat === 'W'
  const board = table.board
  return (
    <PageMain>
      {back}
      <PageTitle>{t.clubs.tableOf(table.clubName, table.number)}</PageTitle>
      <Head>
        <Muted role="note">{t.clubs.guestNotice}</Muted>
        <SeatNames seats={table.seats} />
        <Muted>{t.clubs.boardsPlayed(table.boardsPlayed)}</Muted>
      </Head>
      <Board>
        {!record || !board ? (
          <Muted>{t.clubs.waiting}</Muted>
        ) : (
          <>
            {board.contract && (
              <Line>
                <ContractLabel contract={board.contract} /> · {t.teamMatch.tricksLine(board.tricksWon.NS, board.tricksWon.EW)}
              </Line>
            )}
            <RecordDiagram
              record={record}
              step={record.board.play.length}
              width={Math.round(40 * scale)}
              trickWidth={Math.round((phone ? 34 : 38) * scale)}
              styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
              orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
            />
            <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} size={40} />
          </>
        )}
      </Board>
    </PageMain>
  )
}
