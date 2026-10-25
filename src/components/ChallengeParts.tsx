import styled from 'styled-components'
import type { ChallengeStatus } from '../../shared/challenge.ts'
import { useT } from '../state/PreferencesContext.tsx'

/** Pieces the challenge pages share: a progress bar and the challenge's state */

const Track = styled.span`
  display: inline-block;
  width: 96px;
  height: 8px;
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

const Line = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
`

/** 已打 3／8 副 with a bar */
export function Progress({ played, boards, label }: { played: number; boards: number; label?: string }) {
  const t = useT()
  const text = t.challengeProgress(played, boards)
  return (
    <Line>
      <Track
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={boards}
        aria-valuenow={played}
        aria-label={label ? `${label} · ${text}` : text}
      >
        <Fill $share={boards ? played / boards : 0} />
      </Track>
      <span>{text}</span>
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
  return <Tag $open={status === 'pending' || status === 'active'}>{t.challengeStatuses[status]}</Tag>
}
