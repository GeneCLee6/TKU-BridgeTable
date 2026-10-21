import { Eye, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { TableSummary } from '../../shared/protocol.ts'
import { Button, Card, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { seatLetter, strings } from '../strings.ts'

/** BBO's casual lobby, reduced to what a club needs: start a table, take a seat, or watch */

const Columns = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 24px;
  align-items: start;

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;

  & > h1 { margin: 0; }
`

const Banner = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.primarySoft};
  font-weight: 600;
`

const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
`

const TileHead = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;

  & > h2 { margin: 0; font-size: 18px; color: ${({ theme }) => theme.colors.primaryStrong}; }
`

const MiniTable = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-template-areas:
    '. N .'
    'W felt E'
    '. S .';
  gap: 6px;
  align-items: center;
  justify-items: center;
  margin: 8px 0 12px;
`

const MiniFelt = styled.div`
  grid-area: felt;
  width: 64px;
  height: 44px;
  border-radius: 8px;
  background: ${({ theme }) => theme.table.felt};
  color: ${({ theme }) => theme.table.feltText};
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
`

const SeatButton = styled.button<{ $area: Seat; $taken: boolean }>`
  grid-area: ${({ $area }) => $area};
  width: 100%;
  min-height: 34px;
  padding: 0 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme, $taken }) => ($taken ? theme.colors.border : theme.table.bidPass)};
  background: ${({ theme, $taken }) => ($taken ? theme.colors.surfaceAlt : theme.colors.surface)};
  color: ${({ theme, $taken }) => ($taken ? theme.colors.text : theme.colors.success)};
  font-size: 14px;
  font-weight: 600;
`

const OnlineList = styled.ul`
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  line-height: 2;

  & > li::before {
    content: '';
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 8px;
    border-radius: 50%;
    background: ${({ theme }) => theme.colors.success};
  }
`

const SectionTitle = styled.h2`
  margin: 0;
  font-size: 16px;
`

const SEAT_ORDER: Seat[] = ['N', 'W', 'E', 'S']

function TableTile({ table, onSit, onWatch }: { table: TableSummary; onSit: (seat: Seat) => void; onWatch: () => void }) {
  return (
    <Card>
      <TileHead>
        <h2>{strings.tableName(table.number)}</h2>
        <Muted>
          {strings.host}：{table.hostName}
        </Muted>
      </TileHead>
      <MiniTable>
        {SEAT_ORDER.map((seat) => {
          const occupant = table.seats[seat]
          return (
            <SeatButton
              key={seat}
              type="button"
              $area={seat}
              $taken={!!occupant}
              disabled={!!occupant}
              onClick={() => onSit(seat)}
              aria-label={occupant ? `${seatLetter[seat]} ${occupant.username}` : `${strings.sit} ${seatLetter[seat]}`}
            >
              {seatLetter[seat]} {occupant ? occupant.username : strings.sit}
            </SeatButton>
          )
        })}
        <MiniFelt>{table.boardNo ? `#${table.boardNo}` : '—'}</MiniFelt>
      </MiniTable>
      <TileHead>
        <Muted>
          {strings.boardsPlayed(table.boardsPlayed)} · {strings.spectators(table.spectators)}
        </Muted>
        <Button type="button" $small onClick={onWatch}>
          <Eye size={16} aria-hidden />
          {strings.watch}
        </Button>
      </TileHead>
    </Card>
  )
}

export function LobbyPage() {
  const { lobby, send, status } = useClub()
  const { user } = useAuth()
  const navigate = useNavigate()
  // After creating a table or taking a seat, follow the server to the table it puts us at
  const [follow, setFollow] = useState<{ to?: string; from: string | null } | null>(null)

  if (!lobby) return <PageMain>{status === 'open' ? strings.loading : strings.connecting}</PageMain>
  const here = lobby.myTableId
  if (follow && here && (follow.to ? here === follow.to : here !== follow.from))
    return <Navigate to={`/table/${here}`} />

  return (
    <PageMain>
      <Toolbar>
        <PageTitle>{strings.lobbyTitle}</PageTitle>
        <Button
          type="button"
          $variant="primary"
          onClick={() => {
            setFollow({ from: lobby.myTableId })
            send({ type: 'createTable' })
          }}
        >
          <Plus size={18} aria-hidden />
          {strings.newTable}
        </Button>
      </Toolbar>
      {lobby.myTableId && (
        <Banner>
          <span>{strings.tableName(lobby.tables.find((t) => t.id === lobby.myTableId)?.number ?? 0)}</span>
          <Button as={Link} to={`/table/${lobby.myTableId}`} $small $variant="primary">
            {strings.backToTable}
          </Button>
        </Banner>
      )}
      <Columns>
        <section aria-label={strings.tables}>
          {lobby.tables.length === 0 ? (
            <Card>
              <Muted>{strings.noTables}</Muted>
            </Card>
          ) : (
            <Grid>
              {lobby.tables.map((table) => (
                <TableTile
                  key={table.id}
                  table={table}
                  onSit={(seat) => {
                    setFollow({ to: table.id, from: lobby.myTableId })
                    send({ type: 'sit', tableId: table.id, seat })
                  }}
                  onWatch={() => navigate(`/table/${table.id}`)}
                />
              ))}
            </Grid>
          )}
        </section>
        <Card as="aside" aria-label={strings.online}>
          <SectionTitle>
            {strings.online}（{lobby.online.length}）
          </SectionTitle>
          <OnlineList>
            {lobby.online.map((u) => (
              <li key={u.id}>
                {u.username}
                {u.id === user?.id && `（${strings.you}）`}
              </li>
            ))}
          </OnlineList>
        </Card>
      </Columns>
    </PageMain>
  )
}
