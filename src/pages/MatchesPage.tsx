import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import { isOpenMatch, type TeamMatchView } from '../../shared/team-match.ts'
import { Tag } from '../components/MatchParts.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { matchSettingsLine, mySeat, namedTeam, points, teamName } from '../lib/matches.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The member's team matches (§5.8): the ones they host or have a seat in, newest first, and a
 * button to set one up. Each leads to its prep room (`e8-t06`). Below, the matches being played
 * now (the lobby's list), for anyone to follow and watch either room (AC-8.4)
 */

const Head = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  margin-bottom: 8px;
`

const List = styled.ul`
  display: grid;
  gap: 8px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
`

const Row = styled(Link)`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 12px 16px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  & > strong {
    font-size: 16px;
  }
`

const Live = styled.h2`
  margin: 24px 0 0;
  font-size: 18px;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

export function MatchesPage() {
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const { notifications, lobby, matchLive } = useClub()
  const navigate = useNavigate()
  const [matches, setMatches] = useState<TeamMatchView[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  // An invitation or an answer arrives as a notification, or a match pushed over the socket (§5.8)
  // was cancelled or may no longer be seen: read the list again (the server leaves those out)
  const latest = notifications?.items[0]?.id
  const gone = matchLive && (!matchLive.match || matchLive.match.status === 'cancelled') ? matchLive.matchId : null
  useEffect(() => {
    let live = true
    api
      .matches()
      .then((r) => live && setMatches(r.matches))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [latest, gone, message])

  // Until then the latest push already shows: its row is updated, or taken off when it is gone
  const shown =
    matches && matchLive
      ? matches.flatMap((m) => (m.id !== matchLive.matchId ? [m] : gone ? [] : [matchLive.match ?? m]))
      : matches

  const create = async () => {
    setCreating(true)
    setError('')
    try {
      const { match } = await api.createMatch()
      navigate(`/matches/${match.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
      setCreating(false)
    }
  }

  return (
    <PageMain>
      <Head>
        <PageTitle>{t.teamMatch.title}</PageTitle>
        <Button type="button" $variant="primary" $busy={creating} onClick={() => void create()}>
          {t.teamMatch.create}
        </Button>
      </Head>
      <Muted>{t.teamMatch.intro}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {shown === null ? (
        !error && <Muted>{t.loading}</Muted>
      ) : shown.length === 0 ? (
        <Card>
          <Muted>{t.teamMatch.none}</Muted>
        </Card>
      ) : (
        <List>
          {shown.map((m) => {
            const invited = !!user && m.status === 'setup' && mySeat(m, user.id)?.status === 'invited'
            return (
              <li key={m.id}>
                <Row to={`/matches/${m.id}`}>
                  <strong>{t.teamMatch.vs(teamName(t, m, 'A'), teamName(t, m, 'B'))}</strong>
                  <Tag $open={isOpenMatch(m.status)}>{t.teamMatch.statuses[m.status]}</Tag>
                  {invited && (
                    <Tag $open $accent>
                      {t.teamMatch.invitedBadge}
                    </Tag>
                  )}
                  <Muted as="span">{matchSettingsLine(t, m)}</Muted>
                  {(m.status === 'playing' || m.status === 'finished' || m.status === 'abandoned') && (
                    <span>
                      {points(m.totals.A)} : {points(m.totals.B)}
                    </span>
                  )}
                </Row>
              </li>
            )
          })}
        </List>
      )}
      <Live>{t.teamMatch.live}</Live>
      {!lobby?.matches?.length ? (
        <Muted>{t.teamMatch.noLive}</Muted>
      ) : (
        <List>
          {lobby.matches.map((m) => (
            <li key={m.id}>
              <Row to={`/matches/${m.id}`}>
                <strong>{t.teamMatch.vs(namedTeam(t, m.teamNames, 'A'), namedTeam(t, m.teamNames, 'B'))}</strong>
                <Tag $open>{t.teamMatch.statuses.playing}</Tag>
              </Row>
            </li>
          ))}
        </List>
      )}
    </PageMain>
  )
}
