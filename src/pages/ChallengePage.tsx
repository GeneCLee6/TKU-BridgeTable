import { Image as ImageIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { ChallengeView } from '../../shared/challenge.ts'
import { PlayerGrid, StatusTag } from '../components/ChallengeParts.tsx'
import { ChallengeResults } from '../components/ChallengeResults.tsx'
import { ShareCardDialog } from '../components/ShareCardDialog.tsx'
import {
  ActionLink,
  Button,
  Card,
  ErrorText,
  Muted,
  PageMain,
  PageTitle,
} from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import {
  answerable,
  cancellable,
  challengeTitle,
  formatScore,
  participantName,
  playable,
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
 * no boards, only everyone's progress. Answering, playing (開始打／繼續打) and calling it off are
 * here too: the challenge lobby's cards only open this page (社長 2026-10-27). The standings and the
 * participants use the width — as many to a row as fit — since a challenge can have ~20 people.
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

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

/** The places across the width, read row by row: as many columns as fit, one on a narrow phone */
const Ranks = styled.ol`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
  gap: 6px 12px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;

  & > li {
    display: grid;
    grid-template-columns: 2.2em minmax(0, 1fr) auto;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    font-size: 15px;
  }
  & > li[aria-current='true'] {
    border-color: ${({ theme }) => theme.colors.primary};
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
  }
`

const Place = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`

const Who = styled.span`
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`

const Total = styled.span<{ $value?: number }>`
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0
      ? 'inherit'
      : $value > 0
        ? theme.colors.success
        : theme.colors.danger};
`

export function ChallengePage() {
  const { challengeId = '' } = useParams()
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const { notifications, lobby, send } = useClub()
  const [challenge, setChallenge] = useState<ChallengeView | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [rematching, setRematching] = useState(false)
  const [sharing, setSharing] = useState(false)
  const navigate = useNavigate()
  // After 開始打, follow the server to the challenge table it puts us at
  const [following, setFollowing] = useState<{ from: string | null } | null>(null)

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
    <Back back to="/challenges">
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
    return (
      <PageMain>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
      </PageMain>
    )

  const here = lobby?.myTableId ?? null
  if (following && here && here !== following.from) return <Navigate to={`/table/${here}`} />

  const c = challenge
  const me = playerOf(c, user.id)
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

  const act = (call: () => Promise<{ challenge: ChallengeView }>) => {
    setError('')
    call()
      .then((r) => setChallenge(r.challenge))
      .catch((e) =>
        setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)),
      )
  }
  const play = () => {
    setFollowing({ from: here })
    send({ type: 'playChallenge', challengeId: c.id })
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
          <Button
            type="button"
            $small
            $variant="primary"
            disabled={rematching}
            onClick={() => void rematch()}
          >
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
      {(answerable(c, user.id, now) || playable(c, user.id, now) || cancellable(c, user.id)) && (
        <Meta>
          <Actions>
            {answerable(c, user.id, now) && (
              <>
                <Button
                  type="button"
                  $variant="primary"
                  onClick={() => act(() => api.answerChallenge(c.id, true))}
                >
                  {t.acceptChallenge}
                </Button>
                <Button type="button" onClick={() => act(() => api.answerChallenge(c.id, false))}>
                  {t.declineChallenge}
                </Button>
              </>
            )}
            {playable(c, user.id, now) && (
              <Button type="button" $variant="primary" onClick={play}>
                {me?.startedAt !== undefined ? t.resumeChallenge : t.startChallenge}
              </Button>
            )}
            {cancellable(c, user.id) && (
              <Button
                type="button"
                $variant="danger"
                onClick={() =>
                  window.confirm(t.cancelChallengeConfirm) && act(() => api.cancelChallenge(c.id))
                }
              >
                {t.cancelChallenge}
              </Button>
            )}
          </Actions>
        </Meta>
      )}
      {sharing && card && (
        <ShareCardDialog challenge={c} data={card} onClose={() => setSharing(false)} />
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-labelledby="standings-title">
        <h2 id="standings-title">{standings?.final ? t.standingsFinal : t.viewStandings}</h2>
        {!standings ? (
          <Muted>
            {c.status === 'finished' || open ? t.standingsHidden : t.challengeStatuses[c.status]}
          </Muted>
        ) : (
          <>
            {!standings.final && <Muted>{t.standingsLive}</Muted>}
            {standings.ranked.length === 0 && <Muted>{t.standingsNone}</Muted>}
            {standings.ranked.length === 1 && c.settings.scoring !== 'total' && (
              <Muted>{t.standingsSolo}</Muted>
            )}
            {standings.ranked.length > 0 && (
              <Muted aria-hidden>
                {t.totalCol} · {t.scorings[standings.scoring]}
              </Muted>
            )}
            {standings.ranked.length + standings.unfinished.length > 0 && (
              <Ranks aria-label={`${t.totalCol} · ${t.scorings[standings.scoring]}`}>
                {standings.ranked.map((r) => (
                  <li key={r.userId} aria-current={r.userId === user.id ? 'true' : undefined}>
                    <Place>{r.rank}</Place>
                    <Who title={nameOf(r.userId)}>
                      {nameOf(r.userId)}
                      {playerOf(c, r.userId)?.knownDeals && (
                        <Muted as="span"> · {t.knownDeals}</Muted>
                      )}
                      {/* The total counts a director's ruling on these boards (`e2-t36`) */}
                      {r.ruled && <Muted as="span"> · {t.director.ruledBoards(r.ruled.join(', '))}</Muted>}
                    </Who>
                    <Total $value={tone(r.total, standings.scoring)}>
                      {formatScore(r.total, standings.scoring)}
                    </Total>
                  </li>
                ))}
                {standings.unfinished.map((u) => (
                  <li key={u.userId} aria-current={u.userId === user.id ? 'true' : undefined}>
                    <Place>—</Place>
                    <Who title={nameOf(u.userId)}>{nameOf(u.userId)}</Who>
                    {/* Short, so the name keeps its room in a narrow column; the whole of it for a screen reader */}
                    <Muted
                      as="span"
                      title={`${t.unfinished} · ${t.challengeProgress(u.played, c.boards)}`}
                    >
                      <span aria-hidden>
                        {u.played}/{c.boards}
                      </span>
                      <span className="visually-hidden">
                        {t.unfinished} · {t.challengeProgress(u.played, c.boards)}
                      </span>
                    </Muted>
                  </li>
                ))}
              </Ranks>
            )}
          </>
        )}
      </Section>

      <ChallengeResults challenge={c} userId={user.id} />

      <Section aria-labelledby="players-title">
        <h2 id="players-title">{t.challengePlayers}</h2>
        <PlayerGrid players={c.players} boards={c.boards} you={{ userId: user.id, name: t.you }} />
      </Section>
    </PageMain>
  )
}
