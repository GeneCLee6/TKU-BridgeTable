import { useEffect, useId, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import styled from 'styled-components'
import { isOpenChallenge, type ChallengeView } from '../../shared/challenge.ts'
import type { DailyEventSettings, DailyEventView } from '../../shared/daily-event.ts'
import { ROBOT_KINDS, type RobotKind } from '../../shared/protocol.ts'
import { StatusTag } from '../components/ChallengeParts.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { formatScore, participantName, playerOf, settingsLine, timeLeft, tone } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 每日賽 (`e9-t03`, AC-9.1): today's event with its play button and the standings so far, yesterday's
 * standings and the earlier days. Each day is a challenge (`settings.daily`, ARCHITECTURE.md §5.17),
 * so its results page is the challenge's (`/challenges/:id`), and what the server sends already
 * follows §4: today's standings only once the member played every board. Admins turn it on here.
 */

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-bottom: 10px;
`

const Ranks = styled.ol`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
  gap: 6px 12px;
  margin: 8px 0;
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

const Total = styled.span<{ $value: number }>`
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  color: ${({ $value, theme }) =>
    $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

const Days = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;

  & > li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 8px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
  & > li:first-child {
    border-top: 0;
  }
`

const Settings = styled.form`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;

  & > label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }
`

/** The ranked members of a day, the viewer's own row highlighted */
function Standings({ c, userId }: { c: ChallengeView; userId: string }) {
  const { t } = usePreferences()
  const standings = c.standings
  if (!standings) return <Muted>{t.standingsHidden}</Muted>
  if (!standings.ranked.length) return <Muted>{t.standingsNone}</Muted>
  return (
    <Ranks aria-label={`${t.totalCol} · ${t.scorings[standings.scoring]}`}>
      {standings.ranked.map((r) => {
        const name = participantName(t, playerOf(c, r.userId))
        return (
          <li key={r.userId} aria-current={r.userId === userId ? 'true' : undefined}>
            <Place>{r.rank}</Place>
            <Who title={name}>{name}</Who>
            <Total $value={tone(r.total, standings.scoring)}>{formatScore(r.total, standings.scoring)}</Total>
          </li>
        )
      })}
    </Ranks>
  )
}

/** An admin turns the daily event on or off and picks the robots' system */
function DailySettings({ view, onSaved }: { view: DailyEventView; onSaved: (view: DailyEventView) => void }) {
  const { t, lang, message } = usePreferences()
  const id = useId()
  const [settings, setSettings] = useState<DailyEventSettings>(view.settings)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const change = (patch: Partial<DailyEventSettings>) => {
    setSaved(false)
    setSettings((old) => ({ ...old, ...patch }))
  }
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const { daily } = await api.admin.saveDailyEvent(settings)
      setSettings(daily.settings)
      setSaved(true)
      onSaved(daily)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.daily.settings}</h2>
      <Muted>{t.daily.settingsHint}</Muted>
      <Settings
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label>
          <input type="checkbox" checked={settings.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
          {t.daily.enabled}
        </label>
        <label htmlFor={`${id}-robots`}>
          {t.challengeRobots}
          <Select
            id={`${id}-robots`}
            value={settings.robotKind}
            onChange={(e) => change({ robotKind: e.target.value as RobotKind })}
          >
            {ROBOT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t.robots[k]}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" $variant="primary" $small disabled={saving}>
          {t.save}
        </Button>
        {saved && <Muted role="status">{t.saved}</Muted>}
      </Settings>
      <Muted data-testid="daily-next">
        {view.next ? t.weeklyChallengeNext(formatDateTime(view.next, lang)) : t.weeklyChallengeOff}
      </Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Section>
  )
}

export function DailyPage() {
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const { notifications, lobby, send } = useClub()
  const [view, setView] = useState<DailyEventView | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  // After 開打, follow the server to the challenge table it puts us at
  const [following, setFollowing] = useState<{ from: string | null } | null>(null)
  const here = lobby?.myTableId ?? null

  // The results notification, or coming back from the table, may change it
  const latest = notifications?.items[0]?.id
  useEffect(() => {
    let live = true
    api
      .daily()
      .then((r) => {
        if (!live) return
        setView(r.daily)
        setNow(Date.now())
      })
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [latest, here, message])

  if (!user) return null
  if (following && here && here !== following.from) return <Navigate to={`/table/${here}`} />
  if (!view)
    return (
      <PageMain>
        <PageTitle>{t.daily.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
      </PageMain>
    )

  const today = view.today
  const me = today && playerOf(today, user.id)
  const canPlay =
    !!today &&
    !!me &&
    me.status !== 'declined' &&
    !me.knownDeals &&
    me.played < today.boards &&
    isOpenChallenge(today.status) &&
    now < today.deadline

  // 開打: the invitation is accepted on the way (every member is invited), then the server seats them
  const play = async (c: ChallengeView) => {
    setError('')
    try {
      if (playerOf(c, user.id)?.status === 'invited') await api.answerChallenge(c.id, true)
      setFollowing({ from: here })
      send({ type: 'playChallenge', challengeId: c.id })
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
    }
  }

  return (
    <PageMain>
      <PageTitle>{t.daily.title}</PageTitle>
      <Muted>{t.daily.intro}</Muted>
      {!view.settings.enabled && <Muted>{t.daily.off}</Muted>}
      {user.admin && <DailySettings view={view} onSaved={setView} />}
      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-labelledby="daily-today">
        <h2 id="daily-today">{t.daily.today}</h2>
        {!today ? (
          <Muted>{t.daily.noToday}</Muted>
        ) : (
          <>
            <Meta>
              <StatusTag status={today.status} />
              <Muted as="span">{settingsLine(t, today)}</Muted>
              <Muted as="span">
                {isOpenChallenge(today.status) && now < today.deadline
                  ? `${t.challengeDeadline(formatDateTime(today.deadline, lang))} · ${timeLeft(t, today.deadline - now)}`
                  : t.challengeEndedAt(formatDateTime(today.endedAt ?? today.deadline, lang))}
              </Muted>
            </Meta>
            <Meta>
              {canPlay && (
                <Button type="button" $variant="primary" onClick={() => void play(today)}>
                  {me.startedAt !== undefined ? t.resumeChallenge : t.daily.play}
                </Button>
              )}
              {me && <Muted as="span">{me.played >= today.boards ? t.daily.done : t.daily.progress(me.played, today.boards)}</Muted>}
              <Link to={`/challenges/${today.id}`}>{t.daily.results}</Link>
            </Meta>
            <h3>{t.daily.standings}</h3>
            <Standings c={today} userId={user.id} />
          </>
        )}
      </Section>

      <Section aria-labelledby="daily-yesterday">
        <h2 id="daily-yesterday">{t.daily.yesterday}</h2>
        {!view.yesterday ? (
          <Muted>{t.daily.noYesterday}</Muted>
        ) : (
          <>
            <Meta>
              <StatusTag status={view.yesterday.status} />
              <Link to={`/challenges/${view.yesterday.id}`}>{t.daily.results}</Link>
            </Meta>
            <Standings c={view.yesterday} userId={user.id} />
          </>
        )}
      </Section>

      <Section aria-labelledby="daily-history">
        <h2 id="daily-history">{t.daily.history}</h2>
        {!view.history.length ? (
          <Muted>{t.daily.noHistory}</Muted>
        ) : (
          <Days>
            {view.history.map((d) => (
              <li key={d.challengeId}>
                <Link to={`/challenges/${d.challengeId}`}>{t.daily.titleOn(d.day)}</Link>
                <StatusTag status={d.status} />
                <Muted as="span">{t.daily.finished(d.finished)}</Muted>
              </li>
            ))}
          </Days>
        )}
      </Section>
    </PageMain>
  )
}
