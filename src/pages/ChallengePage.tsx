import { ChevronLeft, Image as ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { ChallengeView } from '../../shared/challenge.ts'
import { Progress, StatusTag } from '../components/ChallengeParts.tsx'
import { ChallengeResults } from '../components/ChallengeResults.tsx'
import { ShareCardDialog } from '../components/ShareCardDialog.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import {
  challengeTitle,
  formatScore,
  participantName,
  playerOf,
  rematchable,
  settingsLine,
  timeLeft,
  tone,
} from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { shareCardData } from '../lib/shareCard.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * A challenge's results (`e7-t18`, AC-7.5; redone after BBO's challenge results, 社長 2026-10-25):
 * places and totals, with the viewer's own row highlighted and those who did not play every board
 * listed after the ranked as 未完成 with how far they got; then the viewer against each other
 * player and every board's results (`ChallengeResults`), each board opening its own page. What the
 * server sends already follows §4 (`challengeView`): someone still playing gets no standings and
 * no boards, only everyone's progress.
 */

const Back = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
  color: ${({ theme }) => theme.colors.primary};
  font-weight: 600;
  text-decoration: none;
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

const People = styled.ul`
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;

  & > li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  & > li > strong { min-width: 96px; }
`

const Scroll = styled.div`
  overflow-x: auto;
  margin-top: 8px;
`

const Table = styled.table`
  border-collapse: collapse;
  font-size: 15px;
  white-space: nowrap;

  th, td {
    padding: 6px 10px;
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
`

const Num = styled.td<{ $value?: number }>`
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};

  & > a { color: inherit; }
`

const NumHead = styled.th`
  text-align: right !important;
`

export function ChallengePage() {
  const { challengeId = '' } = useParams()
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const { notifications } = useClub()
  const [challenge, setChallenge] = useState<ChallengeView | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [rematching, setRematching] = useState(false)
  const [sharing, setSharing] = useState(false)
  const navigate = useNavigate()

  // Someone finishing sends no notification to the others, but answers and the results do
  const latest = notifications?.items[0]?.id
  useEffect(() => {
    let live = true
    api
      .challenge(challengeId)
      .then((r) => {
        if (!live) return
        setChallenge(r.challenge)
        setNow(Date.now())
      })
      .catch((e) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 404) setChallenge(null)
        else setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
      })
    return () => {
      live = false
    }
  }, [challengeId, latest, message])

  const back = (
    <Back to="/challenges">
      <ChevronLeft size={18} aria-hidden />
      {t.allChallenges}
    </Back>
  )
  if (challenge === null)
    return (
      <PageMain>
        {back}
        <Card>
          <Muted>{t.challengeNotFound}</Muted>
        </Card>
      </PageMain>
    )
  if (!challenge || !user)
    return <PageMain>{error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}</PageMain>

  const c = challenge
  const card = shareCardData(c, user.id)
  const open = c.status === 'pending' || c.status === 'active'
  const standings = c.standings
  const nameOf = (userId: string) => participantName(t, playerOf(c, userId))

  // One-click rematch (`e7-t21`): the same people and settings, new boards
  const rematch = async () => {
    setRematching(true)
    setError('')
    try {
      const { challenge: next } = await api.rematchChallenge(c.id)
      navigate(`/challenges/${next.id}`)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
    } finally {
      setRematching(false)
    }
  }

  return (
    <PageMain>
      {back}
      <PageTitle>{challengeTitle(t, c)}</PageTitle>
      <Meta>
        <StatusTag status={c.status} />
        <Muted as="span">{settingsLine(t, c)}</Muted>
        <Muted as="span" title={t.challengeDeadline(formatDateTime(c.deadline, lang))}>
          {open && now < c.deadline
            ? `${t.challengeDeadline(formatDateTime(c.deadline, lang))} · ${timeLeft(t, c.deadline - now)}`
            : t.challengeEndedAt(formatDateTime(c.endedAt ?? c.deadline, lang))}
        </Muted>
        {rematchable(c, user.id) && (
          <Button type="button" $small $variant="primary" disabled={rematching} onClick={() => void rematch()}>
            {t.rematch}
          </Button>
        )}
        {card && (
          <Button type="button" $small onClick={() => setSharing(true)}>
            <ImageIcon size={16} aria-hidden />
            {t.shareCard}
          </Button>
        )}
      </Meta>
      {sharing && card && <ShareCardDialog challenge={c} data={card} onClose={() => setSharing(false)} />}
      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-labelledby="standings-title">
        <h2 id="standings-title">{standings?.final ? t.standingsFinal : t.viewStandings}</h2>
        {!standings ? (
          <Muted>{c.status === 'finished' || open ? t.standingsHidden : t.challengeStatuses[c.status]}</Muted>
        ) : (
          <>
            {!standings.final && <Muted>{t.standingsLive}</Muted>}
            {standings.ranked.length === 0 && <Muted>{t.standingsNone}</Muted>}
            {standings.ranked.length === 1 && c.settings.scoring !== 'total' && <Muted>{t.standingsSolo}</Muted>}
            <Scroll>
              <Table>
                <thead>
                  <tr>
                    <th scope="col">{t.rankCol}</th>
                    <th scope="col">{t.memberCol}</th>
                    <NumHead scope="col">
                      {t.totalCol} · {t.scorings[standings.scoring]}
                    </NumHead>
                  </tr>
                </thead>
                <tbody>
                  {standings.ranked.map((r) => (
                    <tr key={r.userId} aria-current={r.userId === user.id ? 'true' : undefined}>
                      <td>{r.rank}</td>
                      <td>
                        {nameOf(r.userId)}
                        {playerOf(c, r.userId)?.knownDeals && <Muted as="span"> · {t.knownDeals}</Muted>}
                      </td>
                      <Num $value={tone(r.total, standings.scoring)}>{formatScore(r.total, standings.scoring)}</Num>
                    </tr>
                  ))}
                  {standings.unfinished.map((u) => (
                    <tr key={u.userId} aria-current={u.userId === user.id ? 'true' : undefined}>
                      <td>—</td>
                      <td>{nameOf(u.userId)}</td>
                      <td>
                        <Muted as="span">
                          {t.unfinished} · {t.challengeProgress(u.played, c.boards)}
                        </Muted>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Scroll>
          </>
        )}
      </Section>

      <ChallengeResults challenge={c} userId={user.id} />

      <Section aria-labelledby="players-title">
        <h2 id="players-title">{t.challengePlayers}</h2>
        <People>
          {c.players.map((p) => (
            <li key={p.userId}>
              <strong>{p.userId === user.id ? t.you : participantName(t, p)}</strong>
              {p.status === 'accepted' ? (
                <Progress played={p.played} boards={c.boards} label={participantName(t, p)} />
              ) : (
                <Muted as="span">{t.playerStatuses[p.status]}</Muted>
              )}
            </li>
          ))}
        </People>
      </Section>
    </PageMain>
  )
}
