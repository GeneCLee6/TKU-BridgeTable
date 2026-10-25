import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { CHALLENGE_LIMITS } from '../../shared/challenge.ts'
import { ROBOT_KINDS, type RobotKind } from '../../shared/protocol.ts'
import { WEEKLY_SCORINGS, type WeeklyChallengeSchedule, type WeeklyChallengeView, type WeeklyScoring } from '../../shared/weekly-challenge.ts'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, ErrorText, Muted, Select } from './ui.tsx'

/**
 * 每週社團挑戰 (`e7-t23`, AC-7.7): an admin sets the weekday, hour (Taiwan time), boards, scoring,
 * the robots' system and the days to play; every week the server creates the challenge and invites
 * every member (ARCHITECTURE.md §5.5). Opened from the challenge lobby, for admins only.
 */

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
  width: 100%;
  max-width: 480px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 12px;
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin: 12px 0;

  & > label { display: grid; gap: 6px; font-weight: 700; }
`

const Choice = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
`

const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export function WeeklyChallengeDialog({ onClose }: { onClose: () => void }) {
  const { t, lang, message } = usePreferences()
  const titleId = useId()
  const [view, setView] = useState<WeeklyChallengeView | null>(null)
  const [schedule, setSchedule] = useState<WeeklyChallengeSchedule | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let live = true
    api.admin
      .weeklyChallenge()
      .then((r) => {
        if (!live) return
        setView(r.weekly)
        setSchedule(r.weekly.schedule)
      })
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [message])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const change = (patch: Partial<WeeklyChallengeSchedule>) => {
    setSaved(false)
    setSchedule((old) => (old ? { ...old, ...patch } : old))
  }

  const save = async () => {
    if (!schedule) return
    setSaving(true)
    setError('')
    try {
      const { weekly } = await api.admin.saveWeeklyChallenge(schedule)
      setView(weekly)
      setSchedule(weekly.schedule)
      setSaved(true)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
    } finally {
      setSaving(false)
    }
  }

  const id = (name: string) => `${titleId}-${name}`
  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.weeklyChallengeTitle}</h2>
        <Muted>{t.weeklyChallengeHint}</Muted>
        {!schedule ? (
          error ? null : <Muted>{t.loading}</Muted>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Choice>
              <input type="checkbox" checked={schedule.enabled} onChange={(e) => change({ enabled: e.target.checked })} />
              {t.weeklyChallengeEnabled}
            </Choice>
            <Grid>
              <label htmlFor={id('weekday')}>
                {t.weeklyChallengeWeekday}
                <Select id={id('weekday')} value={schedule.weekday} onChange={(e) => change({ weekday: Number(e.target.value) })}>
                  {t.weekdays.map((name, day) => (
                    <option key={day} value={day}>
                      {name}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={id('hour')}>
                {t.weeklyChallengeHour}
                <Select id={id('hour')} value={schedule.hour} onChange={(e) => change({ hour: Number(e.target.value) })}>
                  {range(0, 23).map((h) => (
                    <option key={h} value={h}>
                      {`${String(h).padStart(2, '0')}:00`}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={id('boards')}>
                {t.challengeBoardsLabel}
                <Select id={id('boards')} value={schedule.boards} onChange={(e) => change({ boards: Number(e.target.value) })}>
                  {range(CHALLENGE_LIMITS.boardsMin, CHALLENGE_LIMITS.boardsMax).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={id('scoring')}>
                {t.challengeScoring}
                <Select
                  id={id('scoring')}
                  value={schedule.scoring}
                  onChange={(e) => change({ scoring: e.target.value as WeeklyScoring })}
                >
                  {WEEKLY_SCORINGS.map((s) => (
                    <option key={s} value={s}>
                      {t.scorings[s]}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={id('robots')}>
                {t.challengeRobots}
                <Select
                  id={id('robots')}
                  value={schedule.robotKind}
                  onChange={(e) => change({ robotKind: e.target.value as RobotKind })}
                >
                  {ROBOT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t.robots[k]}
                    </option>
                  ))}
                </Select>
              </label>
              <label htmlFor={id('days')}>
                {t.challengeDays}
                <Select id={id('days')} value={schedule.days} onChange={(e) => change({ days: Number(e.target.value) })}>
                  {range(CHALLENGE_LIMITS.daysMin, CHALLENGE_LIMITS.daysMax).map((n) => (
                    <option key={n} value={n}>
                      {t.challengeDaysOption(n)}
                    </option>
                  ))}
                </Select>
              </label>
            </Grid>
            <Muted data-testid="weekly-next">
              {view?.next ? t.weeklyChallengeNext(formatDateTime(view.next, lang)) : t.weeklyChallengeOff}
            </Muted>
            {view?.lastChallengeId && (
              <Muted>
                <Link to={`/challenges/${view.lastChallengeId}`} onClick={onClose}>
                  {t.weeklyChallengeLast}
                </Link>
              </Muted>
            )}
            {error && <ErrorText role="alert">{error}</ErrorText>}
            {saved && <Muted role="status">{t.saved}</Muted>}
            <Buttons>
              <Button type="button" onClick={onClose}>
                {t.close}
              </Button>
              <Button type="submit" $variant="primary" disabled={saving}>
                {t.save}
              </Button>
            </Buttons>
          </form>
        )}
        {!schedule && error && <ErrorText role="alert">{error}</ErrorText>}
      </Panel>
    </Backdrop>
  )
}
