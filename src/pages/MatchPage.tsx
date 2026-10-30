import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { robotKindsFor } from '../../shared/protocol.ts'
import {
  arrangerOf,
  INVITE_MODES,
  isOpenMatch,
  ROOMS,
  segmentCount,
  TEAM_MATCH_LIMITS,
  type MatchSeat,
  type MatchSeatView,
  type Room,
  type TeamMatchSettings,
  type TeamMatchView,
} from '../../shared/team-match.ts'
import { MATCH_SCORINGS, RULINGS, TEAMS, type RulingKind, type Team } from '../../shared/team-scoring.ts'
import { BoardScores, ScoreLine, Tag } from '../components/MatchParts.tsx'
import { ActionLink, Button, Card, ErrorText, Field, FieldLabel, Input, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api, type MatchPlayAction, type MatchSeatAction } from '../lib/api.ts'
import { arranges, betweenSegments, matchSettingsLine, myRoomTable, mySeat, robotsUneven, sameSeat, seatLabel, teamName } from '../lib/matches.ts'
import { useTeamMatch } from '../lib/useTeamMatch.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * A team match's prep room (`e8-t06`, AC-8.2): both teams' rosters, the two rooms' eight seats and
 * who is in each (invited, seated, a robot, online or not), and what the viewer may do there —
 * answer an invitation; as a team's captain invite, add a robot, clear or swap seats (`e8-t05`);
 * move to an empty seat of their team; leave. The host also changes the settings, cancels, and
 * sees whether the match can start and why not, and starts it (`e8-t07`): both rooms open at once and
 * the players are taken to their tables. While it is played and after, the page shows the score of
 * the boards both rooms played (`e8-t10`, `e8-t11`) board by board with each room's contract, lead
 * and result and a side-by-side replay (the result page, `e8-t12`), a way back to the player's own
 * table, and the two rooms for everyone else to watch. While it is played the host pauses, resumes
 * or abandons it, rules on boards over the time limit, has a robot sit in for a player, and with a
 * team's captain brings in a substitute (`e8-t14`–`e8-t16`). The server pushes every change
 * (`match`), so the page stays live without polling.
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-bottom: 16px;
`

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Rooms = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
`

const Seats = styled.ul`
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const SeatRow = styled.li<{ $team: Team }>`
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-left: 4px solid ${({ theme, $team }) => ($team === 'A' ? theme.colors.primary : theme.colors.accent)};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
`

const Line = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;

  & > strong {
    overflow-wrap: anywhere;
  }
`

const Dot = styled.span<{ $on: boolean }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme, $on }) => ($on ? theme.colors.success : theme.colors.borderStrong)};
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const Rosters = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;

  & h3 {
    margin: 0 0 6px;
    font-size: 15px;
  }
  & ul {
    margin: 0;
    padding-left: 18px;
  }
`

const Warning = styled.p`
  margin: 0 0 16px;
  padding: 8px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.accentStrong};
`

const Form = styled.form`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px 16px;
  align-items: end;
`

const Check = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
`

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
`

const Picker = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;

  & > select {
    flex: 1 1 160px;
    width: auto;
  }
`

export function MatchPage() {
  const { matchId = '' } = useParams()
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const { lobby } = useClub()
  const navigate = useNavigate()
  const { match, setMatch, error: loadError } = useTeamMatch(matchId)
  const [actionError, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** The seat a captain picked to swap (換位), waiting for the other seat */
  const [moving, setMoving] = useState<MatchSeat | null>(null)
  /** The empty seat whose invite picker is open, and the member chosen there */
  const [inviting, setInviting] = useState<MatchSeat | null>(null)
  const [invitee, setInvitee] = useState('')

  const error =
    actionError ||
    (loadError ? (loadError instanceof ApiError ? message(loadError.code, loadError.params, loadError.message) : String(loadError)) : '')

  // The match starts while the page is open: a player goes straight to their table
  const status = useRef(match?.status)
  const myTable = match && user ? myRoomTable(match, user.id) : undefined
  useEffect(() => {
    const before = status.current
    status.current = match?.status
    if (before === 'setup' && match?.status === 'playing' && myTable) navigate(`/table/${myTable}`)
  }, [match?.status, myTable, navigate])

  const fail = (e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))

  const run = async (call: () => Promise<{ match: TeamMatchView | null }>) => {
    setBusy(true)
    setError('')
    try {
      const r = await call()
      setMatch(r.match)
      setMoving(null)
      setInviting(null)
      setInvitee('')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const seatAction = (action: MatchSeatAction) => run(() => api.matchSeat(matchId, action))
  const playAction = (action: MatchPlayAction) => run(() => api.matchPlay(matchId, action))

  const back = (
    <Back back to="/matches">
      {t.teamMatch.all}
    </Back>
  )
  if (match === null)
    return (
      <PageMain>
        {back}
        <Card>
          <Muted>{t.teamMatch.notFound}</Muted>
        </Card>
      </PageMain>
    )
  if (!match || !user)
    return <PageMain>{error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}</PageMain>

  const m = match
  const me = user.id
  const isHost = m.hostId === me
  const setup = m.status === 'setup'
  const mine = mySeat(m, me)
  const hostName = m.seats.find((s) => s.userId === m.hostId)?.user?.username ?? t.deletedMember
  const nameOf = (s: MatchSeatView) =>
    s.robot ? t.robots[m.settings.robotKind] : s.userId === me ? `${s.user?.username ?? ''}（${t.teamMatch.you}）` : (s.user?.username ?? t.deletedMember)
  const captainOf = (team: Team) => (team === 'A' ? m.captains.A : m.captains.B)
  // Members the viewer may invite: not robots, not already in the match, not ones they blocked
  const inMatch = new Set(m.seats.flatMap((s) => (s.userId ? [s.userId] : [])))
  const candidates = (lobby?.members ?? []).filter(
    (u) => !u.robot && u.id !== me && !inMatch.has(u.id) && !lobby?.blocked.includes(u.id),
  )

  const playing = m.status === 'playing'
  const paused = playing && m.pausedAt !== undefined
  /** Between segments (`e8-t21`): captains swap their team's seats and bring in substitutes, the host starts the next */
  const onBreak = betweenSegments(m)
  /** A captain picks a seat of their team, then the seat to swap it with (換位) */
  const moveButtons = (s: MatchSeatView, captain: boolean) => {
    const buttons = []
    if (moving && !sameSeat(moving, s)) {
      const movingTeam = m.seats.find((x) => sameSeat(x, moving))?.team
      if (movingTeam === s.team)
        buttons.push(
          <Button key="here" type="button" $size="sm" $variant="primary" disabled={busy} onClick={() => void seatAction({ action: 'move', from: moving, to: s })}>
            {t.teamMatch.moveHere}
          </Button>,
        )
    }
    if (s.status !== 'empty' && captain && !moving)
      buttons.push(
        <Button key="move" type="button" $size="sm" $variant="ghost" disabled={busy} onClick={() => setMoving({ room: s.room, seat: s.seat })}>
          {t.teamMatch.move}
        </Button>,
      )
    if (moving && sameSeat(moving, s))
      buttons.push(
        <Button key="stop" type="button" $size="sm" $variant="ghost" onClick={() => setMoving(null)}>
          {t.teamMatch.cancelMove}
        </Button>,
      )
    return buttons
  }
  /**
   * While it is played: the host has a robot sit in (代打); paused or between segments, the host or
   * the team's captain brings in a substitute (替補); between segments the captain swaps seats
   */
  const playActions = (s: MatchSeatView) => {
    const buttons = onBreak ? moveButtons(s, arranges(m, me, s)) : []
    if (isHost && s.status === 'seated' && !s.robot && s.userId !== undefined && !s.substitute)
      buttons.push(
        <Button key="sitin" type="button" $size="sm" $variant="ghost" disabled={busy} onClick={() => void playAction({ action: 'sitin', room: s.room, seat: s.seat })}>
          {t.teamMatch.sitIn}
        </Button>,
      )
    if ((paused || onBreak) && s.userId !== m.hostId && (isHost || arrangerOf(m, s.team) === me))
      buttons.push(
        <Button key="replace" type="button" $size="sm" $variant="ghost" disabled={busy} onClick={() => setInviting(inviting && sameSeat(inviting, s) ? null : s)}>
          {t.teamMatch.replace}
        </Button>,
      )
    return buttons.length ? <Actions>{buttons}</Actions> : null
  }

  const seatActions = (s: MatchSeatView) => {
    if (playing) return playActions(s)
    if (!setup) return null
    const captain = arranges(m, me, s)
    const buttons = moveButtons(s, captain)
    if (s.status === 'empty') {
      if (captain) {
        buttons.push(
          <Button key="invite" type="button" $size="sm" disabled={busy} onClick={() => setInviting(inviting && sameSeat(inviting, s) ? null : s)}>
            {t.teamMatch.invite}
          </Button>,
        )
        if (m.settings.robots)
          buttons.push(
            <Button key="robot" type="button" $size="sm" disabled={busy} onClick={() => void seatAction({ action: 'robot', room: s.room, seat: s.seat })}>
              {t.teamMatch.addRobot}
            </Button>,
          )
      } else if (!moving && mine?.status === 'seated' && mine.team === s.team)
        buttons.push(
          <Button key="sit" type="button" $size="sm" disabled={busy} onClick={() => void seatAction({ action: 'move', from: mine, to: s })}>
            {t.teamMatch.moveHere}
          </Button>,
        )
    } else {
      if ((captain || isHost) && s.userId !== m.hostId && s.userId !== me)
        buttons.push(
          <Button key="clear" type="button" $size="sm" $variant="ghost" disabled={busy} onClick={() => void seatAction({ action: 'clear', room: s.room, seat: s.seat })}>
            {s.status === 'invited' ? t.teamMatch.withdraw : t.teamMatch.remove}
          </Button>,
        )
    }
    return buttons.length ? <Actions>{buttons}</Actions> : null
  }

  const invitePicker = (s: MatchSeatView) =>
    inviting && sameSeat(inviting, s) ? (
      <Picker>
        <Select
          $size="sm"
          aria-label={playing ? t.teamMatch.replaceWho(seatLabel(t, s)) : t.teamMatch.inviteWho(seatLabel(t, s))}
          value={invitee}
          onChange={(e) => setInvitee(e.target.value)}
        >
          <option value="">{t.teamMatch.pickMember}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
              {u.online ? `（${t.teamMatch.online}）` : ''}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          $size="sm"
          $variant="primary"
          disabled={!invitee || busy}
          onClick={() =>
            void (playing
              ? playAction({ action: 'replace', room: s.room, seat: s.seat, userId: invitee })
              : seatAction({ action: 'invite', room: s.room, seat: s.seat, userId: invitee }))
          }
        >
          {playing ? t.teamMatch.replace : t.teamMatch.invite}
        </Button>
      </Picker>
    ) : null

  const confirmThen = (text: string, then: () => void) => {
    if (window.confirm(text)) then()
  }

  return (
    <PageMain>
      {back}
      <PageTitle>{t.teamMatch.vs(teamName(t, m, 'A'), teamName(t, m, 'B'))}</PageTitle>
      <Meta>
        <Tag $open={isOpenMatch(m.status)}>{t.teamMatch.statuses[m.status]}</Tag>
        {paused && (
          <Tag $open $accent>
            {t.teamMatch.paused}
          </Tag>
        )}
        {playing && m.segment !== undefined && <Tag $open>{t.teamMatch.segmentNow(m.segment, segmentCount(m.settings))}</Tag>}
        {onBreak && (
          <Tag $open $accent>
            {t.teamMatch.breakTag}
          </Tag>
        )}
        <Muted as="span">{matchSettingsLine(t, m)}</Muted>
        <Muted as="span">{t.teamMatch.host(hostName)}</Muted>
      </Meta>
      {error && <ErrorText role="alert">{error}</ErrorText>}

      {setup && mine?.status === 'invited' && (
        <Section aria-labelledby="invitation-title">
          <h2 id="invitation-title">{t.teamMatch.invitedYou(seatLabel(t, mine))}</h2>
          <Bar>
            <Button type="button" $variant="primary" disabled={busy} onClick={() => void seatAction({ action: 'answer', accept: true })}>
              {t.acceptChallenge}
            </Button>
            <Button type="button" disabled={busy} onClick={() => void seatAction({ action: 'answer', accept: false })}>
              {t.declineChallenge}
            </Button>
          </Bar>
        </Section>
      )}

      {paused && <Warning role="status">{t.teamMatch.pausedHint}</Warning>}
      {onBreak && m.segment !== undefined && <Warning role="status">{t.teamMatch.breakHint(m.segment)}</Warning>}
      {setup && m.settings.invite === 'captains' && <Muted>{t.teamMatch.captainsHint}</Muted>}
      {robotsUneven(m) && <Warning role="note">{t.teamMatch.robotsUneven}</Warning>}

      <Rooms>
        {ROOMS.map((room) => (
          <Section key={room} aria-labelledby={`room-${room}`}>
            <h2 id={`room-${room}`}>{t.teamMatch.rooms[room]}</h2>
            <Seats>
              {m.seats
                .filter((s) => s.room === room)
                .map((s) => (
                  <SeatRow key={s.seat} $team={s.team} aria-label={seatLabel(t, s)}>
                    <Line>
                      <span>{t.seatNames[s.seat]}</span>
                      <Muted as="span">{teamName(t, m, s.team)}</Muted>
                      {s.status === 'empty' ? (
                        <Muted as="span">{t.teamMatch.empty}</Muted>
                      ) : (
                        <>
                          {s.online !== undefined && (
                            <Dot $on={s.online} role="img" aria-label={s.online ? t.teamMatch.online : t.teamMatch.offline} />
                          )}
                          <strong>{nameOf(s)}</strong>
                          {s.userId !== undefined && s.userId === captainOf(s.team) && <Tag $open>{t.teamMatch.captain}</Tag>}
                          {s.status === 'invited' && <Tag $open={false}>{t.teamMatch.invited}</Tag>}
                          {s.substitute && (
                            <Tag $open $accent>
                              {t.teamMatch.sittingIn}
                            </Tag>
                          )}
                        </>
                      )}
                    </Line>
                    {seatActions(s)}
                    {invitePicker(s)}
                  </SeatRow>
                ))}
            </Seats>
          </Section>
        ))}
      </Rooms>

      <Section aria-labelledby="rosters-title">
        <h2 id="rosters-title">{t.teamMatch.rosters}</h2>
        <Rosters>
          {(['A', 'B'] as const).map((team) => {
            const people = m.seats.filter((s) => s.team === team && s.status === 'seated' && !s.robot)
            const robots = m.seats.filter((s) => s.team === team && s.robot).length
            return (
              <div key={team}>
                <h3>{teamName(t, m, team)}</h3>
                {people.length === 0 && robots === 0 ? (
                  <Muted>{t.teamMatch.noMembers}</Muted>
                ) : (
                  <ul>
                    {people.map((s) => (
                      <li key={`${s.room}${s.seat}`}>
                        {nameOf(s)}
                        {s.userId === captainOf(team) && `（${t.teamMatch.captain}）`}
                      </li>
                    ))}
                    {robots > 0 && <li>{t.teamMatch.robotCount(robots)}</li>}
                  </ul>
                )}
              </div>
            )
          })}
        </Rosters>
      </Section>

      {!setup && m.status !== 'cancelled' && (
        <Section aria-labelledby="score-title">
          <h2 id="score-title">{m.status === 'playing' ? t.teamMatch.score : t.teamMatch.ended}</h2>
          <Bar>
            <ScoreLine match={m} />
          </Bar>
          {m.status === 'playing' && <Muted>{t.teamMatch.playingHint}</Muted>}
          {m.status === 'abandoned' && <Muted>{t.teamMatch.abandonedNote}</Muted>}
          {m.status === 'playing' && m.tables && (
            <Bar>
              {myTable ? (
                <Button as={Link} to={`/table/${myTable}`} $variant="primary">
                  {t.teamMatch.toTable}
                </Button>
              ) : (
                !mine && (
                  <>
                    {/* Both rooms side by side, with the score and the watchers' chat (e8-t18) */}
                    <Button as={Link} to={`/matches/${encodeURIComponent(m.id)}/vugraph`} $variant="primary">
                      {t.teamMatch.vugraph}
                    </Button>
                    {ROOMS.map((room) => (
                      <Button key={room} as={Link} to={`/table/${m.tables![room]}`}>
                        {t.teamMatch.watchRoom(t.teamMatch.rooms[room])}
                      </Button>
                    ))}
                  </>
                )
              )}
            </Bar>
          )}
          {/* Every board both rooms played, side by side, one after another (e8-t20) */}
          {m.boards.some((b) => b.open && b.closed) && (
            <Bar>
              <Button as={Link} to={`/matches/${encodeURIComponent(m.id)}/replay`}>
                {t.teamMatch.replayAll}
              </Button>
            </Bar>
          )}
          {m.boards.length > 0 && <BoardScores match={m} />}
        </Section>
      )}

      {playing && isHost && <ManageMatch match={m} busy={busy} onAction={(action) => void playAction(action)} />}
      {setup && isHost && <StartBar match={m} busy={busy} onStart={() => void run(() => api.startMatch(m.id))} />}
      {setup && isHost && <SettingsForm key={JSON.stringify(m.settings)} match={m} busy={busy} onSave={(settings) => void run(() => api.matchSettings(m.id, settings))} />}
      {setup && (
        <Bar>
          {isHost ? (
            <Button
              type="button"
              $variant="danger"
              disabled={busy}
              onClick={() => confirmThen(t.teamMatch.confirmCancel, () => void run(() => api.cancelMatch(m.id)))}
            >
              {t.teamMatch.cancelMatch}
            </Button>
          ) : (
            mine && (
              <Button type="button" disabled={busy} onClick={() => confirmThen(t.teamMatch.confirmLeave, () => void seatAction({ action: 'leave' }))}>
                {t.teamMatch.leave}
              </Button>
            )
          )}
        </Bar>
      )}
    </PageMain>
  )
}

/** The time now, again every 15 seconds: whether a room is over its time limit changes with it */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/**
 * What the host does while the match is played (`e8-t14`–`e8-t16`, AC-8.6): pause and resume both
 * rooms, abandon a paused match, and rule on a board a room is still playing past the time limit
 * (Avg, Avg+ or Avg- for a team, with a reason). Where each room is comes only to the host
 * (`TeamMatchView.rooms`); the server checks everything again
 */
function ManageMatch({ match, busy, onAction }: { match: TeamMatchView; busy: boolean; onAction: (action: MatchPlayAction) => void }) {
  const { t } = usePreferences()
  const now = useNow()
  const paused = match.pausedAt !== undefined
  const onBreak = betweenSegments(match)
  const clockNow = match.pausedAt ?? now
  const over = (room: Room) => {
    const clock = match.rooms?.[room]
    return !!clock?.playing && clock.endsAt !== undefined && clockNow >= clock.endsAt
  }
  return (
    <Section aria-labelledby="manage-title">
      <h2 id="manage-title">{t.teamMatch.manage}</h2>
      {onBreak && match.segment !== undefined && (
        <Bar>
          <Button type="button" $variant="primary" disabled={busy} onClick={() => onAction({ action: 'next' })}>
            {t.teamMatch.nextSegment(match.segment + 1)}
          </Button>
        </Bar>
      )}
      <Bar>
        <Button type="button" $variant={paused ? 'primary' : 'secondary'} disabled={busy} onClick={() => onAction({ action: 'pause', paused: !paused })}>
          {paused ? t.teamMatch.resume : t.teamMatch.pause}
        </Button>
        <Button
          type="button"
          $variant="danger"
          disabled={busy || !(paused || onBreak)}
          aria-describedby="abandon-why"
          onClick={() => window.confirm(t.teamMatch.confirmAbandon) && onAction({ action: 'abandon' })}
        >
          {t.teamMatch.abandon}
        </Button>
        <Muted as="span" id="abandon-why">
          {t.teamMatch.pauseFirst}
        </Muted>
      </Bar>
      <Seats>
        {ROOMS.map((room) => {
          const clock = match.rooms?.[room]
          const roomName = t.teamMatch.rooms[room]
          return (
            <li key={room}>
              <Line>
                <strong>{clock?.playing && clock.seq !== null ? t.teamMatch.roomNow(roomName, clock.seq) : t.teamMatch.roomIdle(roomName)}</strong>
                {over(room) ? (
                  <Tag $open $accent>
                    {t.teamMatch.overTime}
                  </Tag>
                ) : (
                  clock?.endsAt !== undefined &&
                  clock.playing && <Muted as="span">{t.teamMatch.timeLeft(Math.max(0, Math.ceil((clock.endsAt - clockNow) / 60_000)))}</Muted>
                )}
              </Line>
              {over(room) && clock?.seq != null && (
                <RuleForm key={clock.seq} match={match} seq={clock.seq} busy={busy} onRule={(ruling) => onAction({ action: 'rule', seq: clock.seq!, ...ruling })} />
              )}
            </li>
          )
        })}
      </Seats>
    </Section>
  )
}

/** The host's ruling on one board (`e8-t15`): Avg, Avg+ or Avg- for a team, and why */
function RuleForm({
  match,
  seq,
  busy,
  onRule,
}: {
  match: TeamMatchView
  seq: number
  busy: boolean
  onRule: (ruling: { ruling: RulingKind; team: Team; reason: string }) => void
}) {
  const { t } = usePreferences()
  const [ruling, setRuling] = useState<RulingKind>('avg')
  const [team, setTeam] = useState<Team>('A')
  const [reason, setReason] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onRule({ ruling, team, reason })
  }
  const id = `rule-${seq}`
  return (
    <Form onSubmit={submit}>
      <Field>
        <FieldLabel htmlFor={`${id}-kind`}>{t.teamMatch.ruleBoard(seq)}</FieldLabel>
        <Select id={`${id}-kind`} $size="sm" value={ruling} onChange={(e) => setRuling(e.target.value as RulingKind)}>
          {RULINGS.map((k) => (
            <option key={k} value={k}>
              {t.teamMatch.rulings[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-team`}>{t.teamMatch.rulingTeam}</FieldLabel>
        <Select id={`${id}-team`} $size="sm" value={team} onChange={(e) => setTeam(e.target.value as Team)}>
          {TEAMS.map((k) => (
            <option key={k} value={k}>
              {teamName(t, match, k)}
            </option>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-reason`}>{t.teamMatch.reason}</FieldLabel>
        <Input id={`${id}-reason`} $size="sm" maxLength={TEAM_MATCH_LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" $size="sm" $variant="primary" disabled={busy || !reason.trim()}>
          {t.teamMatch.submitRuling}
        </Button>
      </div>
    </Form>
  )
}

/** The host's start button (AC-8.2): why it cannot start yet, or ready to start both rooms at once (`e8-t07`) */
function StartBar({ match, busy, onStart }: { match: TeamMatchView; busy: boolean; onStart: () => void }) {
  const { t } = usePreferences()
  const ready = match.ready
  return (
    <Section aria-labelledby="start-title">
      <h2 id="start-title">{t.teamMatch.start}</h2>
      <Bar>
        <Button type="button" $variant="primary" disabled={!ready?.ready || busy} aria-describedby="start-why" onClick={onStart}>
          {t.teamMatch.start}
        </Button>
        <Muted as="span" id="start-why">
          {ready && !ready.ready ? t.teamMatch.notReady[ready.reason] : t.teamMatch.readyToStart}
        </Muted>
      </Bar>
    </Section>
  )
}

/** The host's settings before the start (AC-8.1); the server checks every field again */
function SettingsForm({
  match,
  busy,
  onSave,
}: {
  match: TeamMatchView
  busy: boolean
  onSave: (settings: Partial<TeamMatchSettings>) => void
}) {
  const { t } = usePreferences()
  const { user } = useAuth()
  const robotKinds = robotKindsFor(user)
  // A pushed change (or a save) gives the form a new key, so it starts again from the settings
  const [draft, setDraft] = useState<TeamMatchSettings>(match.settings)
  const set = <K extends keyof TeamMatchSettings>(key: K, value: TeamMatchSettings[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    // A segment as long as the match (the boards were cut) plays it in one go
    onSave({ ...draft, segmentBoards: draft.segmentBoards < draft.boards ? draft.segmentBoards : 0 })
  }
  const { boardsMin, boardsMax, minutesMax, nameMax, segmentMin } = TEAM_MATCH_LIMITS
  /** Boards per segment the host may pick (`e8-t21`): at least two, fewer than the match */
  const segmentChoices = Array.from({ length: Math.max(0, draft.boards - segmentMin) }, (_, i) => segmentMin + i)
  return (
    <Section aria-labelledby="settings-title">
      <h2 id="settings-title">{t.teamMatch.settings}</h2>
      <Form onSubmit={submit}>
        {(['A', 'B'] as const).map((team, i) => (
          <Field key={team}>
            <FieldLabel htmlFor={`team-name-${team}`}>{t.teamMatch.teamName(team)}</FieldLabel>
            <Input
              id={`team-name-${team}`}
              maxLength={nameMax}
              placeholder={t.teamMatch.team(team)}
              value={draft.teamNames[i]}
              onChange={(e) => set('teamNames', (i === 0 ? [e.target.value, draft.teamNames[1]] : [draft.teamNames[0], e.target.value]) as [string, string])}
            />
          </Field>
        ))}
        <Field>
          <FieldLabel htmlFor="match-boards">{t.teamMatch.boards}</FieldLabel>
          <Input
            id="match-boards"
            type="number"
            min={boardsMin}
            max={boardsMax}
            value={draft.boards}
            onChange={(e) => set('boards', Number(e.target.value))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="match-segments">{t.teamMatch.segmentBoards}</FieldLabel>
          <Select
            id="match-segments"
            value={draft.segmentBoards < draft.boards ? draft.segmentBoards : 0}
            onChange={(e) => set('segmentBoards', Number(e.target.value))}
          >
            <option value={0}>{t.teamMatch.noSegments}</option>
            {segmentChoices.map((n) => (
              <option key={n} value={n}>
                {t.teamMatch.segmentOption(n, segmentCount({ boards: draft.boards, segmentBoards: n }))}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="match-scoring">{t.teamMatch.scoring}</FieldLabel>
          <Select id="match-scoring" value={draft.scoring} onChange={(e) => set('scoring', e.target.value as TeamMatchSettings['scoring'])}>
            {MATCH_SCORINGS.map((s) => (
              <option key={s} value={s}>
                {t.teamMatch.scorings[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="match-minutes">{t.teamMatch.boardMinutes}</FieldLabel>
          <Input
            id="match-minutes"
            type="number"
            min={0}
            max={minutesMax}
            value={draft.boardMinutes}
            onChange={(e) => set('boardMinutes', Number(e.target.value))}
          />
        </Field>
        {/* Only a host who may use the club's system chooses the robots; one set up with them before keeps showing it */}
        {(robotKinds.length > 1 || match.settings.robotKind !== 'gib') && (
          <Field>
            <FieldLabel htmlFor="match-robot-kind">{t.teamMatch.robotKind}</FieldLabel>
            <Select id="match-robot-kind" value={draft.robotKind} onChange={(e) => set('robotKind', e.target.value as TeamMatchSettings['robotKind'])}>
              {[...new Set([...robotKinds, match.settings.robotKind])].map((k) => (
                <option key={k} value={k}>
                  {t.robots[k]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="match-invite">{t.teamMatch.inviteMode}</FieldLabel>
          <Select id="match-invite" value={draft.invite} onChange={(e) => set('invite', e.target.value as TeamMatchSettings['invite'])}>
            {INVITE_MODES.map((k) => (
              <option key={k} value={k}>
                {t.teamMatch.inviteModes[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Check>
          <input type="checkbox" checked={draft.robots} onChange={(e) => set('robots', e.target.checked)} />
          {t.teamMatch.robots}
        </Check>
        <Check>
          <input type="checkbox" checked={draft.delay} onChange={(e) => set('delay', e.target.checked)} />
          {t.teamMatch.delay}
        </Check>
        <div>
          <Button type="submit" $variant="primary" disabled={busy}>
            {t.save}
          </Button>
        </div>
      </Form>
    </Section>
  )
}
