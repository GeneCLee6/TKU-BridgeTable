import { Eye, EyeOff, Lock, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { ChallengeView } from '../../shared/challenge.ts'
import type { TableSummary } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { playable } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { TableSettingsDialog } from '../components/TableSettingsDialog.tsx'
import { Button, Card, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { playerName, seatLetter } from '../strings.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'

/** BBO's casual lobby, reduced to what a club needs: start a table, take a seat, or watch */

/** The lobby on the left, BBO's side panel (people, history) on the right */
const Layout = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});

  & > main { overflow-y: auto; }

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
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



const Tags = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
`

const Tag = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: 13px;
  font-weight: 600;
`

const SEAT_ORDER: Seat[] = ['N', 'W', 'E', 'S']

function TableTile({ table, onSit, onWatch }: { table: TableSummary; onSit: (seat: Seat) => void; onWatch: () => void }) {
  const t = useT()
  return (
    <Card>
      <TileHead>
        <h2>{t.tableName(table.number)}</h2>
        <Muted>
          {t.host}：{table.hostName}
        </Muted>
      </TileHead>
      {(table.settings.visibility === 'invite' || !table.settings.allowKibitz) && (
        <Tags>
          {table.settings.visibility === 'invite' && (
            <Tag>
              <Lock size={14} aria-hidden />
              {t.inviteOnly}
            </Tag>
          )}
          {!table.settings.allowKibitz && (
            <Tag>
              <EyeOff size={14} aria-hidden />
              {t.noKibitz}
            </Tag>
          )}
        </Tags>
      )}
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
              aria-label={occupant ? `${seatLetter[seat]} ${playerName(t, occupant)}` : `${t.sit} ${seatLetter[seat]}`}
            >
              {seatLetter[seat]} {occupant ? playerName(t, occupant) : t.sit}
            </SeatButton>
          )
        })}
        <MiniFelt>{table.boardNo ? `#${table.boardNo}` : '—'}</MiniFelt>
      </MiniTable>
      <TileHead>
        <Muted>
          {t.boardsPlayed(table.boardsPlayed)} · {t.spectators(table.spectators)}
        </Muted>
        <Button type="button" $small onClick={onWatch}>
          <Eye size={16} aria-hidden />
          {t.watch}
        </Button>
      </TileHead>
    </Card>
  )
}

const ChallengeRow = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 8px 0;

  & + & { border-top: 1px solid ${({ theme }) => theme.colors.border}; }
`

const ChallengeCard = styled(Card)`
  margin-bottom: 16px;
`

const ChallengeHead = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 8px;

  & > a { color: ${({ theme }) => theme.colors.primary}; font-weight: 600; }
`

const ChallengeRows = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`

/**
 * The challenges the member can play now, to start or carry on (`e7-t15`); answering, starting a
 * challenge and the standings are on the challenge pages (`e7-t16`)
 */
function MyChallenges({ refresh, onPlay }: { refresh: unknown; onPlay: (id: string) => void }) {
  const t = useT()
  const { lang } = usePreferences()
  const { user } = useAuth()
  // When the list was fetched, which is also the time a deadline is checked against
  const [fetched, setFetched] = useState<{ challenges: ChallengeView[]; at: number }>({ challenges: [], at: 0 })
  useEffect(() => {
    let live = true
    api
      .challenges()
      .then((r) => live && setFetched({ challenges: r.challenges, at: Date.now() }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [refresh])
  if (!user) return null
  const open = fetched.challenges.filter((c) => playable(c, user.id, fetched.at))
  if (!open.length) return null
  return (
    <ChallengeCard as="section" aria-label={t.myChallenges}>
      <ChallengeHead>
        <strong>{t.myChallenges}</strong>
        <Link to="/challenges">{t.allChallenges}</Link>
      </ChallengeHead>
      <ChallengeRows>
        {open.map((c) => {
          const me = c.players.find((p) => p.userId === user.id)!
          const creator = c.players.find((p) => p.userId === c.creatorId)?.user?.username ?? '—'
          return (
            <ChallengeRow key={c.id}>
              <span>
                {t.challengeBy(creator)} · {t.challengeProgress(me.played, c.boards)} ·{' '}
                <Muted as="span">{t.challengeDeadline(formatDateTime(c.deadline, lang))}</Muted>
              </span>
              <Button type="button" $small $variant="primary" onClick={() => onPlay(c.id)}>
                {me.startedAt !== undefined ? t.resumeChallenge : t.startChallenge}
              </Button>
            </ChallengeRow>
          )
        })}
      </ChallengeRows>
    </ChallengeCard>
  )
}

export function LobbyPage() {
  const t = useT()
  const { lobby, send, status } = useClub()
  const navigate = useNavigate()
  // After creating a table or taking a seat, follow the server to the table it puts us at
  const [follow, setFollow] = useState<{ to?: string; from: string | null } | null>(null)
  const [opening, setOpening] = useState(false)

  if (!lobby) return <PageMain>{status === 'open' ? t.loading : t.connecting}</PageMain>
  const here = lobby.myTableId
  const myTable = lobby.tables.find((x) => x.id === here)
  if (follow && here && (follow.to ? here === follow.to : here !== follow.from))
    return <Navigate to={`/table/${here}`} />

  return (
    <Layout>
      <PageMain>
        <Toolbar>
          <PageTitle>{t.lobbyTitle}</PageTitle>
          <Button
            type="button"
            $variant="primary"
            onClick={() => setOpening(true)}
          >
            <Plus size={18} aria-hidden />
            {t.newTable}
          </Button>
        </Toolbar>
        {opening && (
          <TableSettingsDialog
            title={t.newTable}
            submitLabel={t.openTable}
            onClose={() => setOpening(false)}
            onSubmit={(settings) => {
              setOpening(false)
              setFollow({ from: lobby.myTableId })
              send({ type: 'createTable', settings })
            }}
          />
        )}
        {lobby.myTableId && (
          <Banner>
            {/* A challenge table is not in the lobby's list */}
            <span>
              {myTable ? t.tableName(myTable.number) : t.challenge}
            </span>
            <Button as={Link} to={`/table/${lobby.myTableId}`} $small $variant="primary">
              {myTable ? t.backToTable : t.backToChallenge}
            </Button>
          </Banner>
        )}
        <MyChallenges
          refresh={lobby.myTableId}
          onPlay={(challengeId) => {
            setFollow({ from: lobby.myTableId })
            send({ type: 'playChallenge', challengeId })
          }}
        />
        <section aria-label={t.tables}>
          {lobby.tables.length === 0 ? (
            <Card>
              <Muted>{t.noTables}</Muted>
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
      </PageMain>
      <SidePanel tabs={['people', 'messages', 'history']} page="lobby" initial="people" />
    </Layout>
  )
}
