import { ChevronLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { ChallengeScoring } from '../../shared/challenge-scoring.ts'
import type { ChallengeView } from '../../shared/challenge.ts'
import { Progress, StatusTag } from '../components/ChallengeParts.tsx'
import { Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { participantName, playerOf, settingsLine, timeLeft } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * A challenge's standings (`e7-t18`, AC-7.5): places, totals and the person × board matrix, with
 * the viewer's own row highlighted and those who did not play every board listed after the ranked
 * as 未完成 with how far they got. What the server sends already follows §4 (`challengeView`):
 * someone still playing gets no standings at all, only everyone's progress.
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

/** A result in the scoring's unit: a percentage for matchpoints, signed IMPs, signed points */
function formatScore(value: number, scoring: ChallengeScoring) {
  const n = Number.isInteger(value) ? String(value) : value.toFixed(scoring === 'mp' ? 1 : 2)
  if (scoring === 'mp') return `${n}%`
  return value > 0 ? `+${n}` : n
}

/** The colour of a result: above or below the average for matchpoints, its sign otherwise */
const tone = (value: number, scoring: ChallengeScoring) => (scoring === 'mp' ? value - 50 : value)

export function ChallengePage() {
  const { challengeId = '' } = useParams()
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const { notifications } = useClub()
  const [challenge, setChallenge] = useState<ChallengeView | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

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
  const creator = participantName(t, playerOf(c, c.creatorId))
  const open = c.status === 'pending' || c.status === 'active'
  const standings = c.standings
  const seqs = Array.from({ length: c.boards }, (_, i) => i + 1)
  const boardNo = (seq: number) => c.travellers?.find((x) => x.seq === seq)?.boardNo ?? seq
  const recordOf = (userId: string, seq: number) =>
    c.travellers?.find((x) => x.seq === seq)?.entries.find((e) => e.userId === userId)?.boardId
  const nameOf = (userId: string) => participantName(t, playerOf(c, userId))
  const withMatrix = !!standings?.ranked.some((r) => r.boards)

  return (
    <PageMain>
      {back}
      <PageTitle>{t.challengeBy(creator)}</PageTitle>
      <Meta>
        <StatusTag status={c.status} />
        <Muted as="span">{settingsLine(t, c)}</Muted>
        <Muted as="span" title={t.challengeDeadline(formatDateTime(c.deadline, lang))}>
          {open && now < c.deadline
            ? `${t.challengeDeadline(formatDateTime(c.deadline, lang))} · ${timeLeft(t, c.deadline - now)}`
            : t.challengeEndedAt(formatDateTime(c.endedAt ?? c.deadline, lang))}
        </Muted>
      </Meta>

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
                    {withMatrix &&
                      seqs.map((seq) => (
                        <NumHead key={seq} scope="col">
                          #{boardNo(seq)}
                        </NumHead>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {standings.ranked.map((r) => (
                    <tr key={r.userId} aria-current={r.userId === user.id ? 'true' : undefined}>
                      <td>{r.rank}</td>
                      <td>{nameOf(r.userId)}</td>
                      <Num $value={tone(r.total, standings.scoring)}>{formatScore(r.total, standings.scoring)}</Num>
                      {withMatrix &&
                        seqs.map((seq, i) => {
                          const value = r.boards?.[i]
                          const record = recordOf(r.userId, seq)
                          if (value === undefined) return <Num key={seq}>—</Num>
                          const text = formatScore(value, standings.scoring)
                          return (
                            <Num key={seq} $value={tone(value, standings.scoring)}>
                              {record ? <Link to={`/history/${record}`}>{text}</Link> : text}
                            </Num>
                          )
                        })}
                    </tr>
                  ))}
                  {standings.unfinished.map((u) => (
                    <tr key={u.userId} aria-current={u.userId === user.id ? 'true' : undefined}>
                      <td>—</td>
                      <td>{nameOf(u.userId)}</td>
                      <td colSpan={withMatrix ? c.boards + 1 : 1}>
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
