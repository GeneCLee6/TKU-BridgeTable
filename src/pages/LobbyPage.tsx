import { Ban, Bot, Dumbbell, Eye, EyeOff, Hand, LayoutGrid, Lock, Plus, Timer, UserPlus, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { ChallengeView } from '../../shared/challenge.ts'
import { missingSeats } from '../../shared/lobby.ts'
import { robotKindsFor, type SeatOccupant, type TableSummary } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { playable } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { Avatar } from '../components/Avatar.tsx'
import { SidePanel } from '../components/SidePanel.tsx'
import { PracticeDialog } from '../components/PracticeDialog.tsx'
import { TableSettingsDialog } from '../components/TableSettingsDialog.tsx'
import { Button, Card, CardFooter, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { playerName, seatLetter, type Strings } from '../strings.ts'
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: ${({ theme }) => theme.space(6)};

  & h1 { margin: 0; }
`

const Banner = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: ${({ theme }) => theme.space(6)};
  padding: 10px 14px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.primarySoft};
  font-weight: 600;
`

/** 和機器人練習 (`e10-t04`): one line on what practice is, and the button that opens it */
const PracticeCard = styled(Card)`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  margin-bottom: ${({ theme }) => theme.space(8)};
  border-left: 4px solid ${({ theme }) => theme.colors.accent};

  & h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 4px;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h3.size};
  }
  & > div { flex: 1 1 280px; }
`

/** A lobby area: an 18px heading with a link or hint on the right */
const Section = styled.section`
  margin-bottom: ${({ theme }) => theme.space(8)};
`

const SectionHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin-bottom: ${({ theme }) => theme.space(3)};

  & > h2 {
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h2.size};
    line-height: ${({ theme }) => theme.type.h2.line};
  }
  & > a { color: ${({ theme }) => theme.colors.primary}; font-size: 14px; font-weight: 600; }
`

const Grid = styled.div`
  display: grid;
  /* Wide enough for a seat cell to hold an avatar and a short name, or TKB and its system */
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: 16px;
`

const TileHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  & > h3 {
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h3.size};
    line-height: ${({ theme }) => theme.type.h3.line};
  }
`

/** "第 6 副" on a table in play, "等人中" in gold on one that has not started: a word, not only a colour */
const StateTag = styled.span<{ $waiting: boolean }>`
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $waiting }) => ($waiting ? theme.colors.accentSoft : theme.colors.primarySoft)};
  color: ${({ theme, $waiting }) => ($waiting ? theme.colors.accentStrong : theme.colors.text)};
  font-size: ${({ theme }) => theme.type.caption.size};
  line-height: ${({ theme }) => theme.type.caption.line};
  font-weight: 700;
  white-space: nowrap;
`

/**
 * The four seats around a small felt, as a compass. Every seat cell is as wide as the side columns
 * (N and S centred over the felt) and has a fixed height: a long name is cut with an ellipsis and
 * never makes the cell, or the card, grow; the full name is in `title`
 */
const FELT = 48
const SEAT_GAP = 8

const MiniTable = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) ${FELT}px minmax(0, 1fr);
  grid-template-areas:
    'N N N'
    'W felt E'
    'S S S';
  gap: ${SEAT_GAP}px;
  align-items: center;
  justify-items: center;
  margin: 12px 0 0;
`

const MiniFelt = styled.div`
  grid-area: felt;
  width: ${FELT}px;
  height: 44px;
  border-radius: 8px;
  background: ${({ theme }) => theme.table.felt};
  color: ${({ theme }) => theme.table.feltText};
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
`

/** A taken seat is solid; an empty one a dashed "+ 坐 W" outline (green stays for the felt) */
const SeatButton = styled.button<{ $area: Seat; $taken: boolean }>`
  grid-area: ${({ $area }) => $area};
  display: flex;
  align-items: center;
  justify-content: ${({ $taken }) => ($taken ? 'flex-start' : 'center')};
  gap: 4px;
  /* N and S span the row but are as wide as W and E */
  width: ${({ $area }) => ($area === 'N' || $area === 'S' ? `calc(50% - ${FELT / 2 + SEAT_GAP}px)` : '100%')};
  min-width: 0;
  height: 36px;
  padding: 0 6px;
  overflow: hidden;
  white-space: nowrap;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px ${({ $taken }) => ($taken ? 'solid' : 'dashed')}
    ${({ theme, $taken }) => ($taken ? theme.colors.border : theme.colors.borderStrong)};
  background: ${({ theme, $taken }) => ($taken ? theme.colors.surfaceAlt : theme.colors.surface)};
  color: ${({ theme, $taken }) => ($taken ? theme.colors.text : theme.colors.primary)};
  font-size: 13px;
  font-weight: 600;

  & > svg { flex: none; }
  &:hover:not(:disabled) { background: ${({ theme }) => theme.colors.primarySoft}; }
  &:disabled { cursor: default; }
  &:disabled:not([data-taken]) { opacity: 0.45; }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
  }
`

const SeatLetter = styled.span`
  flex: none;
  width: 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: 12px;
  font-weight: 800;
  text-align: center;
`

/** The name gives way first: cut with an ellipsis, never wrapped */
const SeatName = styled.span`
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
`

const SystemTag = styled.span`
  flex: none;
  margin-left: auto;
  padding: 0 4px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.text};
  font-size: 11px;
  line-height: 16px;
  font-weight: 700;
`

/** Who sits there: a robot as a robot icon, "TKB" and its system as a tag; a member as their avatar and name */
function SeatOccupantLabel({ seat, occupant }: { seat: Seat; occupant: SeatOccupant }) {
  const t = useT()
  const kind = occupant.robotKind ?? 'tku'
  return (
    <>
      <SeatLetter aria-hidden>{seatLetter[seat]}</SeatLetter>
      {occupant.robot ? (
        <>
          <Bot size={15} aria-hidden />
          <SeatName>{t.robotName}</SeatName>
          <SystemTag data-system={kind}>{t.robotSystemsShort[kind]}</SystemTag>
        </>
      ) : (
        <>
          <Avatar id={occupant.id} name={occupant.username} size={20} avatar={occupant.avatar} />
          <SeatName>{occupant.username}</SeatName>
        </>
      )}
    </>
  )
}

/** The full name, for `title` and the accessible name: "TKB（淡江制度）", and for whom a robot sits in */
function occupantTitle(t: Strings, occupant: SeatOccupant) {
  const name = playerName(t, occupant)
  return occupant.substituteFor ? `${name} · ${t.substituteFor(occupant.substituteFor)}` : name
}

const Tags = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
`

const Tag = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.accentStrong};
  font-size: ${({ theme }) => theme.type.caption.size};
  line-height: ${({ theme }) => theme.type.caption.line};
  font-weight: 600;
`

/** One line, however long the host's name */
const HostLine = styled(Muted)`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const TileFooter = styled(CardFooter)`
  justify-content: space-between;
`

const SEAT_ORDER: Seat[] = ['N', 'W', 'E', 'S']

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  /*
   * A phone: quick seat and practice side by side, the new table under them across the width, so
   * the three line up the same in every language instead of wrapping wherever the words run out
   */
  ${mobile} {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    width: 100%;

    & > button {
      min-width: 0;
      white-space: normal;
      text-align: center;
    }
    & > button:last-child {
      grid-column: 1 / -1;
    }
  }
`

/** The badge for a table's access mode (none for a public one) */
const ACCESS_ICONS = { request: Hand, hidden: Lock, closed: Ban } as const

export function TableTile({
  table,
  onSit,
  onWatch,
  onRequest,
}: {
  table: TableSummary
  onSit: (seat: Seat) => void
  onWatch: () => void
  /** Asks to join a request table */
  onRequest?: () => void
}) {
  const t = useT()
  const missing = missingSeats(table)
  // Only those the access mode lets in may sit or watch (AC-2.9); at a request table others ask first
  const canWatch = table.welcome && (table.settings.allowKibitz || !!table.practice)
  const asking = !table.welcome && table.settings.access === 'request'
  const access = table.settings.access
  const AccessIcon = access === 'public' ? null : ACCESS_ICONS[access]
  const waiting = !table.boardNo
  return (
    <Card aria-label={t.tableName(table.number)}>
      <TileHead>
        <h3>{t.tableName(table.number)}</h3>
        <StateTag $waiting={waiting}>{waiting ? t.waitingTag : t.boardNo(table.boardNo!)}</StateTag>
      </TileHead>
      <HostLine title={table.hostName}>{t.hostIs(table.hostName)}</HostLine>
      {(missing > 0 || AccessIcon || table.practice || !table.settings.allowKibitz || table.settings.boardMinutes > 0) && (
        <Tags>
          {table.practice && (
            <Tag>
              <Dumbbell size={14} aria-hidden />
              {t.practiceTable}
            </Tag>
          )}
          {missing > 0 && (
            <Tag>
              <UserPlus size={14} aria-hidden />
              {t.missingSeats(missing)}
            </Tag>
          )}
          {AccessIcon && access !== 'public' && (
            <Tag>
              <AccessIcon size={14} aria-hidden />
              {t.accessBadge[access]}
            </Tag>
          )}
          {!table.settings.allowKibitz && !table.practice && (
            <Tag>
              <EyeOff size={14} aria-hidden />
              {t.noKibitz}
            </Tag>
          )}
          {table.settings.boardMinutes > 0 && (
            <Tag>
              <Timer size={14} aria-hidden />
              {t.boardMinutesOption(table.settings.boardMinutes)}
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
              data-taken={occupant ? '' : undefined}
              disabled={!!occupant || !table.welcome}
              onClick={() => onSit(seat)}
              title={occupant ? occupantTitle(t, occupant) : undefined}
              aria-label={occupant ? `${seatLetter[seat]} ${occupantTitle(t, occupant)}` : `${t.sit} ${seatLetter[seat]}`}
            >
              {occupant ? (
                <SeatOccupantLabel seat={seat} occupant={occupant} />
              ) : (
                <>
                  <Plus size={14} aria-hidden />
                  {t.sitSeat(seatLetter[seat])}
                </>
              )}
            </SeatButton>
          )
        })}
        <MiniFelt aria-hidden>{table.boardNo ?? '—'}</MiniFelt>
      </MiniTable>
      <TileFooter>
        <Muted>
          {t.boardsPlayed(table.boardsPlayed)} · {t.spectators(table.spectators)}
        </Muted>
        {asking ? (
          <Button type="button" $size="sm" onClick={onRequest} disabled={!!table.requested}>
            <Hand size={16} aria-hidden />
            {table.requested ? t.requestSent : t.askToJoin}
          </Button>
        ) : (
          <Button type="button" $size="sm" onClick={onWatch} disabled={!canWatch}>
            <Eye size={16} aria-hidden />
            {t.watch}
          </Button>
        )}
      </TileFooter>
    </Card>
  )
}

/** One challenge to carry on: a lantern-gold bar on the left and how far the member got */
const ChallengeRow = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 3px solid ${({ theme }) => theme.colors.accent};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};
`

const ChallengeText = styled.div`
  display: grid;
  gap: 6px;
  min-width: 0;

  & > strong { font-size: 15px; }
`

const ChallengeMeta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.small.size};
`

const Progress = styled.span`
  display: inline-block;
  width: 72px;
  height: 4px;
  overflow: hidden;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surfaceAlt};

  & > span { display: block; height: 100%; background: ${({ theme }) => theme.colors.primary}; }
`

const ChallengeRows = styled.ul`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
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
    <Section aria-labelledby="lobby-challenges">
      <SectionHead>
        <h2 id="lobby-challenges">{t.myChallenges}</h2>
        <Link to="/challenges">{t.allChallenges}</Link>
      </SectionHead>
      <ChallengeRows>
        {open.map((c) => {
          const me = c.players.find((p) => p.userId === user.id)!
          const creator = c.players.find((p) => p.userId === c.creatorId)?.user?.username ?? '—'
          return (
            <ChallengeRow key={c.id}>
              <ChallengeText>
                <strong>{t.challengeBy(creator)}</strong>
                <ChallengeMeta>
                  <Progress aria-hidden>
                    <span style={{ width: `${Math.round((100 * me.played) / Math.max(1, c.boards))}%` }} />
                  </Progress>
                  <span>{t.challengeProgress(me.played, c.boards)}</span>
                  <span>{t.challengeDeadline(formatDateTime(c.deadline, lang))}</span>
                </ChallengeMeta>
              </ChallengeText>
              <Button type="button" $size="sm" onClick={() => onPlay(c.id)}>
                {me.startedAt !== undefined ? t.resumeChallenge : t.startChallenge}
              </Button>
            </ChallengeRow>
          )
        })}
      </ChallengeRows>
    </Section>
  )
}

const EmptyCard = styled(Card)`
  display: grid;
  justify-items: center;
  gap: ${({ theme }) => theme.space(3)};
  padding: ${({ theme }) => theme.space(12)} ${({ theme }) => theme.space(4)};
  text-align: center;

  & > svg { color: ${({ theme }) => theme.colors.borderStrong}; }
`

const SkeletonTile = styled.div`
  height: 260px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

/** Before the lobby arrives: grey blocks the size of the real page; after ten seconds, a word (DESIGN.md §7.6) */
function LobbySkeleton({ slow }: { slow: boolean }) {
  const t = useT()
  return (
    <PageMain aria-busy="true" aria-label={t.loading}>
      <PageTitle>{t.lobbyTitle}</PageTitle>
      {slow && <Muted role="status">{t.slowLoading}</Muted>}
      <Grid style={{ marginTop: 24 }}>
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
      </Grid>
    </PageMain>
  )
}

export function LobbyPage() {
  const t = useT()
  const { lobby, send, status } = useClub()
  const { user } = useAuth()
  const navigate = useNavigate()
  // After creating a table or taking a seat, follow the server to the table it puts us at
  const [follow, setFollow] = useState<{ to?: string; from: string | null } | null>(null)
  const [opening, setOpening] = useState(false)
  const [practising, setPractising] = useState(false)
  // Still connecting after ten seconds: say so (DESIGN.md §7.6)
  const [slowConnect, setSlowConnect] = useState(false)
  useEffect(() => {
    if (lobby) return
    const timer = setTimeout(() => setSlowConnect(true), 10_000)
    return () => clearTimeout(timer)
  }, [lobby])

  if (!lobby) return <LobbySkeleton slow={status !== 'open' && slowConnect} />
  const here = lobby.myTableId
  const myTable = lobby.tables.find((x) => x.id === here)
  if (follow && here && (follow.to ? here === follow.to : here !== follow.from))
    return <Navigate to={`/table/${here}`} />

  return (
    <Layout>
      <PageMain>
        <Toolbar>
          <div>
            <PageTitle>{t.lobbyTitle}</PageTitle>
            <Muted>{t.lobbySummary(lobby.tables.length, lobby.members.filter((m) => m.online).length)}</Muted>
          </div>
          <Actions>
            <Button
              type="button"
              onClick={() => {
                setFollow({ from: lobby.myTableId })
                send({ type: 'quickSeat' })
              }}
            >
              <Zap size={18} aria-hidden />
              {t.quickSeat}
            </Button>
            <Button type="button" onClick={() => setPractising(true)}>
              <Dumbbell size={18} aria-hidden />
              {t.practiceStart}
            </Button>
            <Button type="button" $variant="primary" onClick={() => setOpening(true)}>
              <Plus size={18} aria-hidden />
              {t.newTable}
            </Button>
          </Actions>
        </Toolbar>
        {opening && (
          <TableSettingsDialog
            title={t.newTable}
            submitLabel={t.openTable}
            members={lobby.members.filter((m) => m.id !== user?.id && !lobby.blocked.includes(m.id))}
            onClose={() => setOpening(false)}
            onSubmit={(settings, invitees) => {
              setOpening(false)
              setFollow({ from: lobby.myTableId })
              send({ type: 'createTable', settings, ...(invitees.length > 0 && { invitees }) })
            }}
          />
        )}
        {practising && (
          <PracticeDialog
            robotKinds={robotKindsFor(user)}
            onClose={() => setPractising(false)}
            onSubmit={(settings, access) => {
              setPractising(false)
              setFollow({ from: lobby.myTableId })
              send({ type: 'createPractice', settings, access })
            }}
          />
        )}
        {lobby.myTableId && (
          <Banner>
            {/* A challenge or practice table is not in the lobby's list */}
            <span>
              {lobby.myTableMode === 'practice'
                ? t.practiceTable
                : myTable
                  ? t.tableName(myTable.number)
                  : t.challenge}
            </span>
            <Button as={Link} to={`/table/${lobby.myTableId}`} $small $variant="primary">
              {lobby.myTableMode === 'practice' ? t.backToPractice : myTable ? t.backToTable : t.backToChallenge}
            </Button>
          </Banner>
        )}
        {lobby.myTableMode !== 'practice' && (
          <PracticeCard>
            <div>
              <h2>
                <Dumbbell size={20} aria-hidden />
                {t.practiceTitle}
              </h2>
              <Muted>{t.practiceIntro}</Muted>
            </div>
            <Button type="button" $variant="primary" onClick={() => setPractising(true)}>
              {t.practiceOpen}
            </Button>
          </PracticeCard>
        )}
        <MyChallenges
          refresh={lobby.myTableId}
          onPlay={(challengeId) => {
            setFollow({ from: lobby.myTableId })
            send({ type: 'playChallenge', challengeId })
          }}
        />
        <Section aria-labelledby="lobby-tables">
          <SectionHead>
            <h2 id="lobby-tables">{t.tables}</h2>
            {lobby.tables.length > 0 && <Muted as="span">{t.lobbyTablesHint}</Muted>}
          </SectionHead>
          {lobby.tables.length === 0 ? (
            <EmptyCard>
              <LayoutGrid size={40} aria-hidden />
              <Muted>{t.noTablesShort}</Muted>
              <Button type="button" $size="sm" onClick={() => setOpening(true)}>
                <Plus size={16} aria-hidden />
                {t.newTable}
              </Button>
            </EmptyCard>
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
                  onRequest={() => send({ type: 'requestJoin', tableId: table.id })}
                />
              ))}
            </Grid>
          )}
        </Section>
      </PageMain>
      <SidePanel tabs={['people', 'messages', 'history']} page="lobby" initial="people" />
    </Layout>
  )
}
