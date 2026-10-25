import { Plus, Swords } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import styled, { css } from 'styled-components'
import type { ChallengeView } from '../../shared/challenge.ts'
import { ChallengeDialog } from '../components/ChallengeDialog.tsx'
import { Progress, StatusTag } from '../components/ChallengeParts.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import {
  answerable,
  cancellable,
  CHALLENGE_TABS,
  challengeTab,
  participantName,
  playable,
  playerOf,
  settingsLine,
  timeLeft,
  type ChallengeTab,
} from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The challenge lobby (`e7-t16`, AC-7.7): 等待接受, 進行中 and 已完成, each challenge with its
 * opponents, everyone's progress and the time left. Answering, playing, cancelling and starting a
 * new challenge (`e7-t17`) are all here; a challenge's standings are on its own page (`e7-t18`).
 */

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;

  & > h1 { margin: 0; }
`

const Tabs = styled.div`
  display: inline-flex;
  flex-wrap: wrap;
  margin-bottom: 16px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  overflow: hidden;
`

const TabButton = styled.button<{ $active: boolean }>`
  min-height: 36px;
  padding: 0 16px;
  border: 0;
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  ${({ $active, theme }) =>
    $active &&
    css`
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
`

const List = styled.ul`
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Head = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  margin-bottom: 10px;

  & > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
`

const People = styled.ul`
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;

  & > li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
  }
  & > li > strong { min-width: 96px; }
`

const Label = styled.div`
  margin-bottom: 6px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  font-weight: 600;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

function ChallengeCard({
  c,
  userId,
  now,
  onAct,
  onPlay,
}: {
  c: ChallengeView
  userId: string
  now: number
  onAct: (call: () => Promise<{ challenge: ChallengeView }>) => void
  onPlay: () => void
}) {
  const { t, lang } = usePreferences()
  const me = playerOf(c, userId)
  const creator = participantName(t, playerOf(c, c.creatorId))
  const others = c.players.filter((p) => p.userId !== userId)
  const open = c.status === 'pending' || c.status === 'active'
  return (
    <Card as="li" aria-label={t.challengeBy(creator)}>
      <Head>
        <div>
          <StatusTag status={c.status} />
          <strong>{t.challengeBy(creator)}</strong>
          <Muted as="span">{settingsLine(t, c)}</Muted>
        </div>
        <Muted as="span" title={t.challengeDeadline(formatDateTime(c.deadline, lang))}>
          {open && now < c.deadline
            ? timeLeft(t, c.deadline - now)
            : t.challengeEndedAt(formatDateTime(c.endedAt ?? c.deadline, lang))}
        </Muted>
      </Head>
      <Label>{t.challengeOpponents}</Label>
      <People>
        {others.map((p) => (
          <li key={p.userId}>
            <strong>{participantName(t, p)}</strong>
            {p.status === 'accepted' ? (
              <Progress played={p.played} boards={c.boards} label={participantName(t, p)} />
            ) : (
              <Muted as="span">{t.playerStatuses[p.status]}</Muted>
            )}
          </li>
        ))}
        {me?.status === 'accepted' && (
          <li>
            <strong>{t.challengeYourProgress}</strong>
            <Progress played={me.played} boards={c.boards} label={t.challengeYourProgress} />
          </li>
        )}
      </People>
      <Actions>
        {answerable(c, userId, now) && (
          <>
            <Button type="button" $small $variant="primary" onClick={() => onAct(() => api.answerChallenge(c.id, true))}>
              {t.acceptChallenge}
            </Button>
            <Button type="button" $small onClick={() => onAct(() => api.answerChallenge(c.id, false))}>
              {t.declineChallenge}
            </Button>
          </>
        )}
        {playable(c, userId, now) && (
          <Button type="button" $small $variant="primary" onClick={onPlay}>
            {me?.startedAt !== undefined ? t.resumeChallenge : t.startChallenge}
          </Button>
        )}
        <Button as={Link} to={`/challenges/${c.id}`} $small>
          {t.viewStandings}
        </Button>
        {cancellable(c, userId) && (
          <Button
            type="button"
            $small
            $variant="danger"
            onClick={() => window.confirm(t.cancelChallengeConfirm) && onAct(() => api.cancelChallenge(c.id))}
          >
            {t.cancelChallenge}
          </Button>
        )}
      </Actions>
    </Card>
  )
}

export function ChallengesPage() {
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const { lobby, send, notifications } = useClub()
  const [list, setList] = useState<ChallengeView[] | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<ChallengeTab | null>(null)
  const [creating, setCreating] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  // After 開始打, follow the server to the challenge table it puts us at
  const [following, setFollowing] = useState<{ from: string | null } | null>(null)

  // A new notification (an answer, a reminder, the results) may change the list
  const latest = notifications?.items[0]?.id
  useEffect(() => {
    let live = true
    api
      .challenges()
      .then((r) => {
        if (!live) return
        setList(r.challenges)
        setNow(Date.now())
      })
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [latest, message])

  // The countdowns move once a minute
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!user) return null
  const here = lobby?.myTableId ?? null
  if (following && here && here !== following.from) return <Navigate to={`/table/${here}`} />

  const byTab = (tab: ChallengeTab) => (list ?? []).filter((c) => challengeTab(c, user.id, now) === tab)
  const tab = chosen ?? CHALLENGE_TABS.find((k) => byTab(k).length) ?? 'waiting'
  const shown = byTab(tab)

  const replace = (c: ChallengeView) => setList((old) => [c, ...(old ?? []).filter((x) => x.id !== c.id)].sort((a, b) => b.createdAt - a.createdAt))
  const act = (call: () => Promise<{ challenge: ChallengeView }>) => {
    setError('')
    call()
      .then((r) => replace(r.challenge))
      .catch((e) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
  }

  return (
    <PageMain>
      <Toolbar>
        <PageTitle>{t.navChallenges}</PageTitle>
        <Button type="button" $variant="primary" onClick={() => setCreating(true)}>
          <Plus size={18} aria-hidden />
          {t.newChallenge}
        </Button>
      </Toolbar>
      {creating && (
        <ChallengeDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false)
            replace(c)
            setChosen('waiting')
          }}
        />
      )}
      <Tabs role="tablist" aria-label={t.navChallenges}>
        {CHALLENGE_TABS.map((k) => (
          <TabButton key={k} type="button" role="tab" aria-selected={tab === k} $active={tab === k} onClick={() => setChosen(k)}>
            {t.challengeTabs[k]}
            {list ? ` (${byTab(k).length})` : ''}
          </TabButton>
        ))}
      </Tabs>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {list === null ? (
        <Muted>{t.loading}</Muted>
      ) : shown.length === 0 ? (
        <Card>
          <Muted>
            <Swords size={16} aria-hidden /> {t.noChallenges[tab]}
          </Muted>
        </Card>
      ) : (
        <List role="tabpanel" aria-label={t.challengeTabs[tab]}>
          {shown.map((c) => (
            <ChallengeCard
              key={c.id}
              c={c}
              userId={user.id}
              now={now}
              onAct={act}
              onPlay={() => {
                setFollowing({ from: here })
                send({ type: 'playChallenge', challengeId: c.id })
              }}
            />
          ))}
        </List>
      )}
    </PageMain>
  )
}
