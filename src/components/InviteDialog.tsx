import { BellRing } from 'lucide-react'
import { useEffect, useId } from 'react'
import styled from 'styled-components'
import type { Notification } from '../../shared/protocol.ts'
import { teamAt } from '../../shared/team-match.ts'
import { participantName, settingsLine, timeLeft } from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import type { InviteDetail } from '../lib/invites.ts'
import { matchSettingsLine, mySeat, seatLabel, teamName } from '../lib/matches.ts'
import { notificationText } from '../lib/notifications.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { Backdrop, Buttons, Panel } from './TableSettingsDialog.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * The invitation dialog (`e1-t35`, DESIGN.md §5.5): in the middle of the screen, who invites the
 * member to what, and 接受／拒絕／稍後回覆 at once. When the invitation no longer stands (called
 * off, past its deadline, answered elsewhere) it says so and only closes. At a table the member
 * is playing at, `InviteBanner` stands in for it in the header until it is opened.
 */

const Facts = styled.ul`
  display: grid;
  gap: 6px;
  margin: 0 0 ${({ theme }) => theme.space(4)};
  padding: 0;
  list-style: none;
  font-size: 15px;
`

const More = styled.p`
  margin: 0 0 ${({ theme }) => theme.space(3)};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Stale = styled.p`
  margin: 0 0 ${({ theme }) => theme.space(4)};
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
`

/** The facts of the invitation, one per line */
function useFacts(detail: InviteDetail | null, userId: string, now: number): string[] {
  const { t, lang } = usePreferences()
  if (!detail) return []
  if (detail.kind === 'challenge') {
    const c = detail.challenge
    const others = c.players.filter((p) => p.userId !== userId).map((p) => participantName(t, p))
    return [
      settingsLine(t, c),
      `${t.challengeDeadline(formatDateTime(c.deadline, lang))} · ${timeLeft(t, c.deadline - now)}`,
      t.invites.players(others.join('、')),
    ]
  }
  const m = detail.match
  const seat = mySeat(m, userId)
  const host = m.seats.find((s) => s.userId === m.hostId)?.user?.username
  return [
    t.teamMatch.vs(teamName(t, m, 'A'), teamName(t, m, 'B')),
    ...(seat ? [t.invites.seat(seatLabel(t, seat), teamName(t, m, teamAt(seat.room, seat.seat)))] : []),
    matchSettingsLine(t, m),
    ...(host ? [t.teamMatch.host(host)] : []),
    t.invites.start,
  ]
}

export function InviteDialog({
  invite,
  detail,
  userId,
  now,
  more,
  stale,
  busy,
  onAccept,
  onDecline,
  onLater,
}: {
  /** The invitation notification */
  invite: Notification
  /** The challenge or match, once fetched */
  detail: InviteDetail | null
  userId: string
  /** For the time left to a challenge's deadline */
  now: number
  /** How many other invitations wait after this one */
  more: number
  /** It no longer stands: only 關閉 (which is `onLater`) */
  stale: boolean
  busy: boolean
  onAccept: () => void
  onDecline: () => void
  onLater: () => void
}) {
  const { t } = usePreferences()
  const titleId = useId()
  const facts = useFacts(detail, userId, now)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onLater()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onLater])

  return (
    <Backdrop>
      <Panel role="alertdialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{notificationText(t, invite)}</h2>
        {more > 0 && <More>{t.invites.more(more)}</More>}
        {stale ? (
          <Stale role="status">{t.invites.stale}</Stale>
        ) : detail ? (
          <Facts>
            {facts.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </Facts>
        ) : (
          <Muted>{t.loading}</Muted>
        )}
        <Buttons>
          {stale ? (
            <Button type="button" onClick={onLater}>
              {t.close}
            </Button>
          ) : (
            <>
              <Button type="button" $variant="ghost" disabled={busy} onClick={onLater}>
                {t.invites.later}
              </Button>
              <Button type="button" disabled={busy || !detail} onClick={onDecline}>
                {t.declineChallenge}
              </Button>
              <Button type="button" $variant="primary" $busy={busy} disabled={!detail} onClick={onAccept}>
                {t.acceptChallenge}
              </Button>
            </>
          )}
        </Buttons>
      </Panel>
    </Backdrop>
  )
}

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  min-height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.header};
  font-size: 13px;
  font-weight: 700;

  & > span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  ${mobile} {
    & > span { display: none; }
  }
`

/** At a table the member plays at: the invitation waits in the header, out of the cards' way */
export function InviteBanner({ invite, count, onOpen }: { invite: Notification; count: number; onOpen: () => void }) {
  const { t } = usePreferences()
  const text = count > 1 ? `${notificationText(t, invite)} · ${t.invites.banner(count)}` : notificationText(t, invite)
  return (
    <Chip type="button" onClick={onOpen} aria-label={`${text} · ${t.invites.view}`} title={text}>
      <BellRing size={16} aria-hidden />
      <span>{text}</span>
    </Chip>
  )
}
