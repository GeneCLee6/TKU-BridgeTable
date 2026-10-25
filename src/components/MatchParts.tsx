import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { TeamMatchView } from '../../shared/team-match.ts'
import { points, teamName } from '../lib/matches.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/** Pieces the team match pages share (§5.8) */

/** A small label: the match's state (open ones stand out), or 「邀請你」 in the accent colour */
export const Tag = styled.span<{ $open: boolean; $accent?: boolean }>`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentSoft : $open ? theme.colors.primarySoft : theme.colors.surfaceAlt};
  color: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentStrong : $open ? theme.colors.primaryStrong : theme.colors.textMuted};
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

const Score = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  font-variant-numeric: tabular-nums;

  & > strong {
    font-size: 1.15em;
  }
`

/**
 * The match score (AC-8.5): both teams' names and totals, counting only boards both rooms played
 * (or the host ruled on), how many those are, and once it ended who won
 */
export function ScoreLine({ match }: { match: TeamMatchView }) {
  const { t } = usePreferences()
  const a = teamName(t, match, 'A')
  const b = teamName(t, match, 'B')
  const ended = match.status === 'finished' || match.status === 'abandoned'
  return (
    <Score role="group" aria-label={t.teamMatch.score}>
      <span>{a}</span>
      <strong>
        {points(match.totals.A)} : {points(match.totals.B)}
      </strong>
      <span>{b}</span>
      <small>
        {ended
          ? match.leader
            ? t.teamMatch.winner(match.leader === 'A' ? a : b)
            : t.teamMatch.tie
          : t.teamMatch.boardsDone(match.boards.length, match.settings.boards)}
      </small>
    </Score>
  )
}

const Grid = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;

  & th,
  & td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: right;
  }
  & th:first-child,
  & td:first-child {
    text-align: left;
  }
  & thead th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
  }
  & a {
    color: ${({ theme }) => theme.colors.primary};
  }
`

/**
 * Each scored board (AC-8.5): both rooms' North-South scores, linked to their records, and what
 * each team won. Only boards both rooms played (or the host ruled on) are in the match view at all
 */
export function BoardScores({ match }: { match: TeamMatchView }) {
  const { t } = usePreferences()
  const scoreOf = (room?: { boardId: string; scoreNS: number }) =>
    room ? <Link to={`/history/${encodeURIComponent(room.boardId)}`}>{room.scoreNS}</Link> : '—'
  return (
    <Grid>
      <thead>
        <tr>
          <th scope="col">{t.teamMatch.boardColumn}</th>
          <th scope="col">{t.teamMatch.roomScore(t.teamMatch.rooms.open)}</th>
          <th scope="col">{t.teamMatch.roomScore(t.teamMatch.rooms.closed)}</th>
          <th scope="col">{teamName(t, match, 'A')}</th>
          <th scope="col">{teamName(t, match, 'B')}</th>
        </tr>
      </thead>
      <tbody>
        {match.boards.map((b) => (
          <tr key={b.seq}>
            <th scope="row">
              {b.seq}
              {b.ruling && ` · ${t.teamMatch.ruled}`}
            </th>
            <td>{scoreOf(b.open)}</td>
            <td>{scoreOf(b.closed)}</td>
            <td>{points(b.result.A)}</td>
            <td>{points(b.result.B)}</td>
          </tr>
        ))}
      </tbody>
    </Grid>
  )
}
