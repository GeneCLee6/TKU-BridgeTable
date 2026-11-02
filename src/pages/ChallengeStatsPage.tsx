import { useEffect, useState } from 'react'
import styled from 'styled-components'
import type { ChallengeStatsView } from '../../shared/challenge-stats.ts'
import { ActionLink, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'
import { mobile } from '../styles/tokens.ts'

/**
 * The member's challenge record (`e7-t29`, `/challenges/stats`): how many challenges they finished
 * ranked, first places, win rate and average IMPs, then the head to head with everyone they met.
 * The server works it all out (`ChallengeExtras.stats`) from finished challenges only, which every
 * participant already sees in full (§4); it only answers for the member asking.
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Tiles = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin: 0 0 16px;

  & > div {
    padding: 12px 14px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.lg};
    background: ${({ theme }) => theme.colors.surface};
  }
  dt {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
  dd {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
`

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;
  white-space: nowrap;

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  tr:last-child > td, tr:last-child > th {
    border-bottom: 0;
  }
  thead th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  [data-num] {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  ${mobile} {
    font-size: 14px;
    th, td {
      padding: 6px 5px;
    }
    [data-wide] {
      display: none;
    }
  }
`

const Signed = styled.td<{ $value: number }>`
  color: ${({ $value, theme }) => ($value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger)};
`

const signed = (n: number, digits = 0) => {
  const text = n.toFixed(digits)
  return n > 0 ? `+${text}` : text
}

export function ChallengeStatsPage() {
  const { t, lang, message } = usePreferences()
  const [stats, setStats] = useState<ChallengeStatsView | null>(null)
  const [error, setError] = useState('')
  const s = t.challengeExtras

  useEffect(() => {
    let live = true
    api
      .challengeStats()
      .then((r) => live && setStats(r.stats))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [message])

  const record = (w: number, l: number, d: number) => `${w}–${l}–${d}`

  return (
    <PageMain>
      <Back back to="/challenges">
        {t.allChallenges}
      </Back>
      <PageTitle>{s.statsTitle}</PageTitle>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!stats ? (
        !error && <Muted>{t.loading}</Muted>
      ) : stats.challenges === 0 ? (
        <Card>
          <Muted>{s.statsEmpty}</Muted>
        </Card>
      ) : (
        <>
          <Tiles>
            <div>
              <dt>{s.statsChallenges}</dt>
              <dd>{stats.challenges}</dd>
            </div>
            <div>
              <dt>{s.statsFirsts}</dt>
              <dd>{stats.firsts}</dd>
            </div>
            <div>
              <dt>{s.statsWinRate}</dt>
              <dd>{stats.winRate === null ? '—' : `${Math.round(stats.winRate * 100)}%`}</dd>
            </div>
            <div>
              <dt>{s.statsRecord}</dt>
              <dd>{record(stats.wins, stats.losses, stats.draws)}</dd>
            </div>
            <div>
              <dt>{s.statsAverageImps}</dt>
              <dd>{stats.averageImps === null ? '—' : signed(stats.averageImps, 2)}</dd>
            </div>
          </Tiles>
          <Muted>{s.statsNote}</Muted>
          <Section aria-labelledby="opponents-title">
            <h2 id="opponents-title">{s.statsOpponents}</h2>
            <Scroll>
              <Table>
                <thead>
                  <tr>
                    <th scope="col">{s.opponentCol}</th>
                    <th scope="col" data-num>
                      {s.challengesCol}
                    </th>
                    <th scope="col" data-num>
                      {s.statsRecord}
                    </th>
                    <th scope="col" data-num data-wide>
                      {s.boardsCol}
                    </th>
                    <th scope="col" data-num>
                      {s.impsCol}
                    </th>
                    <th scope="col" data-wide>
                      {s.lastCol}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stats.opponents.map((o) => (
                    <tr key={o.opponent}>
                      <th scope="row">{o.user ? playerName(t, o.user) : t.deletedMember}</th>
                      <td data-num>{o.challenges}</td>
                      <td data-num>{record(o.wins, o.losses, o.draws)}</td>
                      <td data-num data-wide>
                        {o.boards}
                      </td>
                      <Signed data-num $value={o.imps}>
                        {signed(o.imps)}
                      </Signed>
                      <td data-wide>{formatDate(o.lastAt, lang)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Scroll>
          </Section>
        </>
      )}
    </PageMain>
  )
}
