import styled, { css } from 'styled-components'
import type { ChallengePlayerView, ChallengeStatus } from '../../shared/challenge.ts'
import { participantName } from '../lib/challenges.ts'
import { useT } from '../state/PreferencesContext.tsx'

/**
 * Pieces the challenge pages share: a progress bar, the challenge's state, and the participants
 * laid out across the width (up to ~20 of them, 社長 2026-10-27), not in one long column
 */

const Track = styled.span<{ $compact: boolean }>`
  display: inline-block;
  flex: none;
  width: ${({ $compact }) => ($compact ? 40 : 96)}px;
  height: ${({ $compact }) => ($compact ? 6 : 8)}px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.surfaceAlt};
  border: 1px solid ${({ theme }) => theme.colors.border};
  overflow: hidden;
  vertical-align: middle;
`

const Fill = styled.span<{ $share: number }>`
  display: block;
  height: 100%;
  width: ${({ $share }) => `${Math.round($share * 100)}%`};
  background: ${({ theme }) => theme.colors.success};
`

const Line = styled.span<{ $compact: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: ${({ $compact }) => ($compact ? 6 : 8)}px;
  font-size: ${({ $compact }) => ($compact ? 12 : 14)}px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`

/** 已打 3／8 副 with a bar; `compact` (a card's participants) writes it 3/8 beside a short bar */
export function Progress({
  played,
  boards,
  label,
  compact = false,
}: {
  played: number
  boards: number
  label?: string
  compact?: boolean
}) {
  const t = useT()
  const text = t.challengeProgress(played, boards)
  return (
    <Line $compact={compact}>
      <Track
        $compact={compact}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={boards}
        aria-valuenow={played}
        aria-label={label ? `${label} · ${text}` : text}
      >
        <Fill $share={boards ? played / boards : 0} />
      </Track>
      <span aria-hidden={compact || undefined}>{compact ? `${played}/${boards}` : text}</span>
    </Line>
  )
}

const Tag = styled.span<{ $open: boolean }>`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $open }) => ($open ? theme.colors.primarySoft : theme.colors.surfaceAlt)};
  color: ${({ theme, $open }) => ($open ? theme.colors.primaryStrong : theme.colors.textMuted)};
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

export function StatusTag({ status }: { status: ChallengeStatus }) {
  const t = useT()
  return (
    <Tag $open={status === 'pending' || status === 'active'}>{t.challengeStatuses[status]}</Tag>
  )
}

/** Participants side by side, as many to a row as fit; on a phone two (or one) to a row */
const Grid = styled.ul<{ $compact: boolean }>`
  display: grid;
  grid-template-columns: repeat(
    auto-fill,
    minmax(min(100%, ${({ $compact }) => ($compact ? 128 : 150)}px), 1fr)
  );
  gap: ${({ $compact }) => ($compact ? '4px 10px' : '8px 16px')};
  margin: 0;
  padding: 0;
  list-style: none;

  & > li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    ${({ $compact }) =>
      !$compact &&
      css`
        padding: 6px 10px;
        border: 1px solid ${({ theme }) => theme.colors.border};
        border-radius: ${({ theme }) => theme.radius.sm};
      `}
  }
  & > li > strong {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: ${({ $compact }) => ($compact ? 13 : 15)}px;
    font-weight: ${({ $compact }) => ($compact ? 600 : 700)};
  }
  & > li > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 12px;
    white-space: nowrap;
  }
`

/**
 * Participants with their progress (or why they are not playing); `compact` for a challenge card,
 * which shows at most `max` and says how many more there are. `you` names the viewer's own entry
 */
export function PlayerGrid({
  players,
  boards,
  compact = false,
  max,
  you,
}: {
  players: ChallengePlayerView[]
  boards: number
  compact?: boolean
  max?: number
  you?: { userId: string; name: string }
}) {
  const t = useT()
  const shown = max === undefined ? players : players.slice(0, max)
  const more = players.length - shown.length
  return (
    <Grid $compact={compact}>
      {shown.map((p) => {
        const name = p.userId === you?.userId ? you.name : participantName(t, p)
        return (
          <li key={p.userId}>
            <strong title={name}>{name}</strong>
            {p.status === 'accepted' ? (
              <Progress played={p.played} boards={boards} label={participantName(t, p)} compact />
            ) : (
              <small>{t.playerStatuses[p.status]}</small>
            )}
          </li>
        )
      })}
      {more > 0 && (
        <li>
          <small aria-hidden>+{more}</small>
          <span className="visually-hidden">{t.morePlayers(more)}</span>
        </li>
      )}
    </Grid>
  )
}
