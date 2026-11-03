import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { TeamEventTeamView, TeamEventView } from '../../shared/team-event.ts'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'

/**
 * 多隊賽 (`e9-t14`, AC-9.5, ARCHITECTURE.md §5.25): one multi-team event made from a tournament —
 * the standings by VP (with the tie-breaks spelled out), every round's pairings and each match's
 * IMPs and VP (each match played on its own page, `/matches/:id`, where its referee tools are),
 * the viewer's match or bye this round, the teams and the line-up a captain sets for the next
 * round, and for the director the next round and cancelling. What the server sends follows §4:
 * another team's line-up for the next round is never sent.
 */

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;

  & > label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }
`

const Status = styled.span`
  padding: 1px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: 13px;
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  border-collapse: collapse;
  width: 100%;
  font-size: 15px;
  white-space: nowrap;
  margin-bottom: 12px;

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  tr[aria-current='true'] td {
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
  }
  caption {
    text-align: left;
    font-weight: 700;
    padding: 4px 0;
  }
`

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;

  & > li {
    padding: 8px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
  & > li:first-child {
    border-top: 0;
  }
  & > li[aria-current='true'] {
    font-weight: 700;
  }
`

const Notice = styled.p`
  margin: 0 0 10px;
  padding: 8px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.successSoft};
  color: ${({ theme }) => theme.colors.text};
`

const r2 = (n: number) => Math.round(n * 100) / 100

function useErrorText() {
  const { message } = usePreferences()
  return useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)), [message])
}

/** A captain's (or the director's) form for the next round's four: the open room pair, then the closed room pair */
function LineupForm({ eventId, team, index, onSaved }: { eventId: string; team: TeamEventTeamView; index: number; onSaved: (view: TeamEventView) => void }) {
  const t = useT()
  const te = t.teamEvents
  const errorText = useErrorText()
  const [picked, setPicked] = useState<string[]>(() => (team.lineup.length === 4 ? team.lineup : team.players.slice(0, 4).map((p) => p.id)))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const name = (id: string) => team.players.find((p) => p.id === id)?.username || t.deletedMember
  const choose = (slot: number, id: string) => {
    setSaved(false)
    setPicked((now) => now.map((p, i) => (i === slot ? id : p)))
  }
  const select = (slot: number, label: string) => (
    <Select aria-label={`${label} ${(slot % 2) + 1}`} value={picked[slot]} onChange={(e) => choose(slot, e.target.value)}>
      {team.players.map((p) => (
        <option key={p.id} value={p.id}>
          {name(p.id)}
        </option>
      ))}
    </Select>
  )
  return (
    <form
      aria-label={te.lineup}
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        api.teamEvents
          .lineup(eventId, index, picked)
          .then((r) => {
            setSaved(true)
            onSaved(r.event)
          })
          .catch((e) => setError(errorText(e)))
      }}
    >
      <Muted>{te.lineupHint}</Muted>
      <Row>
        <label>
          {te.openPair}
          {select(0, te.openPair)}
          {select(1, te.openPair)}
        </label>
        <label>
          {te.closedPair}
          {select(2, te.closedPair)}
          {select(3, te.closedPair)}
        </label>
        <Button type="submit" $variant="primary" disabled={new Set(picked).size !== 4}>
          {te.saveLineup}
        </Button>
        {saved && <span role="status">{te.lineupSaved}</span>}
      </Row>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </form>
  )
}

export function TeamEventPage() {
  const { t, lang } = usePreferences()
  const te = t.teamEvents
  const { eventId = '' } = useParams()
  const errorText = useErrorText()
  const [view, setView] = useState<TeamEventView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.teamEvents
      .get(eventId)
      .then((r) => setView(r.event))
      .catch((e) => setError(errorText(e)))
  }, [eventId, errorText])
  useEffect(load, [load])
  // The scores and standings: read again every few seconds while it is played
  const playing = view?.status === 'playing'
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [playing, load])

  const act = (run: () => Promise<{ event: TeamEventView }>) => {
    setBusy(true)
    setError('')
    run()
      .then((r) => setView(r.event))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }

  if (!view)
    return (
      <PageMain>
        <PageTitle>{te.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
      </PageMain>
    )

  const teamName = (i: number) => view.teams[i]?.name || te.team(i + 1)
  const current = view.played.at(-1)
  const myBye = view.myTeam !== undefined && current && !current.done && current.bye === view.myTeam

  return (
    <PageMain>
      <PageTitle>{view.title}</PageTitle>
      <Section aria-label={view.title}>
        <Row>
          <Status>{te.status[view.status]}</Status>
          <span>{te.formats[view.format]}</span>
          <span>{te.summary(view.rounds, view.settings.boards)}</span>
          <Muted as="span">{te.director(view.director.username || t.deletedMember)}</Muted>
          {view.finishedAt !== undefined && <Muted as="span">{formatDateTime(view.finishedAt, lang)}</Muted>}
        </Row>
        {view.myMatch && (
          <Notice>
            {te.myMatch} <Link to={`/matches/${view.myMatch}`}>{te.goMatch}</Link>
          </Notice>
        )}
        {myBye && <Notice>{te.myBye}</Notice>}
        {view.status === 'finished' && <Muted>{te.finishedNote}</Muted>}
        {(view.canNext || view.canCancel) && (
          <>
            {view.canNext && <Muted>{te.nextHint}</Muted>}
            <Row>
              {view.canNext && (
                <Button type="button" $variant="primary" disabled={busy} onClick={() => act(() => api.teamEvents.next(view.id))}>
                  {te.next(view.played.length + 1)}
                </Button>
              )}
              {view.canCancel && (
                <Button
                  type="button"
                  $variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(te.confirmCancel)) act(() => api.teamEvents.cancel(view.id))
                  }}
                >
                  {te.cancel}
                </Button>
              )}
            </Row>
          </>
        )}
        {view.tournamentId && <Link to={`/tournaments/${view.tournamentId}`}>{te.tournament}</Link>}
      </Section>

      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-labelledby="team-event-standings">
        <h2 id="team-event-standings">{te.standings}</h2>
        <Scroll>
          <Table>
            <thead>
              <tr>
                <th scope="col">{te.rank}</th>
                <th scope="col">{te.teamCol}</th>
                <th scope="col">{te.vp}</th>
                <th scope="col">{te.played}</th>
                <th scope="col">{te.byes}</th>
                <th scope="col">{te.imps}</th>
                <th scope="col">{te.quotient}</th>
              </tr>
            </thead>
            <tbody>
              {view.standings.map((s) => (
                <tr key={s.team} aria-current={s.team === view.myTeam ? 'true' : undefined}>
                  <td>{s.rank}</td>
                  <td>{teamName(s.team)}</td>
                  <td>{r2(s.vp)}</td>
                  <td>{s.played}</td>
                  <td>{s.byes}</td>
                  <td>
                    {r2(s.impsFor)} : {r2(s.impsAgainst)}
                  </td>
                  <td>{s.quotient === null ? '∞' : s.quotient}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Scroll>
        <Muted>{te.tieBreaks}</Muted>
      </Section>

      <Section aria-labelledby="team-event-rounds">
        <h2 id="team-event-rounds">{te.rounds}</h2>
        {!view.played.length ? (
          <Muted>{te.noRounds}</Muted>
        ) : (
          [...view.played].reverse().map((r) => (
            <Scroll key={r.n}>
              <Table>
                <caption>{te.round(r.n)}</caption>
                <tbody>
                  {r.matches.map((m) => (
                    <tr key={m.matchId} aria-current={m.a === view.myTeam || m.b === view.myTeam ? 'true' : undefined}>
                      <td>{te.match(teamName(m.a), teamName(m.b))}</td>
                      <td>{te.matchStatus[m.status]}</td>
                      <td>{te.imp(r2(m.imps.A), r2(m.imps.B))}</td>
                      <td>{m.vp ? te.vpScore(m.vp.A, m.vp.B) : '—'}</td>
                      <td>{m.status !== 'gone' && <Link to={`/matches/${m.matchId}`}>{te.openMatch}</Link>}</td>
                    </tr>
                  ))}
                  {r.bye !== undefined && (
                    <tr aria-current={r.bye === view.myTeam ? 'true' : undefined}>
                      <td colSpan={5}>{te.bye(teamName(r.bye))}</td>
                    </tr>
                  )}
                </tbody>
              </Table>
            </Scroll>
          ))
        )}
      </Section>

      <Section aria-labelledby="team-event-teams">
        <h2 id="team-event-teams">{te.teams}</h2>
        <List>
          {view.teams.map((team, i) => (
            <li key={team.id} aria-current={i === view.myTeam ? 'true' : undefined}>
              <Row>
                <strong>{teamName(i)}</strong>
                {team.players.map((p) => (
                  <Link key={p.id} to={`/members/${p.id}`}>
                    {p.username || t.deletedMember}
                  </Link>
                ))}
              </Row>
              {team.canLineup ? (
                <LineupForm eventId={view.id} team={team} index={i} onSaved={setView} />
              ) : (
                team.lineup.length === 4 && (
                  <Row>
                    <Muted as="span">{te.lineup}</Muted>
                    {team.lineup.map((id) => (
                      <span key={id}>{team.players.find((p) => p.id === id)?.username || t.deletedMember}</span>
                    ))}
                  </Row>
                )
              )}
            </li>
          ))}
        </List>
      </Section>
    </PageMain>
  )
}
