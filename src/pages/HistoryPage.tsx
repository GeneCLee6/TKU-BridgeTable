import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled, { css } from 'styled-components'
import type { BoardSummary } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { ContractLabel } from '../components/Suit.tsx'
import { Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { strings } from '../strings.ts'

/** BBO's history list: every finished board, newest first; click one to open it */

const Toggle = styled.div`
  display: inline-flex;
  margin-bottom: 16px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  overflow: hidden;
`

const ToggleButton = styled.button<{ $active: boolean }>`
  min-height: 36px;
  padding: 0 16px;
  border: 0;
  background: ${({ theme }) => theme.colors.surface};
  font-weight: 600;
  ${({ $active, theme }) =>
    $active &&
    css`
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
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
    padding: 8px 10px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  tbody tr {
    cursor: pointer;
    &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
  }
`

const Num = styled.td<{ $value?: number }>`
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

const RowLink = styled.a`
  color: inherit;
  text-decoration: none;
`

export function HistoryPage() {
  const [all, setAll] = useState(false)
  // The list is tagged with the scope it was loaded for, so switching scope shows "loading"
  const [loaded, setLoaded] = useState<{ all: boolean; boards: BoardSummary[] } | null>(null)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const boards = loaded?.all === all ? loaded.boards : null

  useEffect(() => {
    let cancelled = false
    api
      .history(all)
      .then(({ boards }) => !cancelled && setLoaded({ all, boards }))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [all])

  return (
    <PageMain>
      <PageTitle>{strings.historyTitle}</PageTitle>
      <Toggle role="group" aria-label={strings.historyTitle}>
        <ToggleButton type="button" $active={!all} aria-pressed={!all} onClick={() => setAll(false)}>
          {strings.historyMine}
        </ToggleButton>
        <ToggleButton type="button" $active={all} aria-pressed={all} onClick={() => setAll(true)}>
          {strings.historyAll}
        </ToggleButton>
      </Toggle>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Card>
        {!boards ? (
          <Muted>{strings.loading}</Muted>
        ) : boards.length === 0 ? (
          <Muted>{strings.historyEmpty}</Muted>
        ) : (
          <Scroll>
            <Table>
              <thead>
                <tr>
                  <th>{strings.date}</th>
                  <th>{strings.board}</th>
                  <th>{strings.ns}</th>
                  <th>{strings.ew}</th>
                  <th>{strings.contract}</th>
                  <th>{strings.result}</th>
                  <th style={{ textAlign: 'right' }}>{strings.scoreNS}</th>
                </tr>
              </thead>
              <tbody>
                {boards.map((b) => (
                  <tr key={b.id} onClick={() => navigate(`/history/${b.id}`)}>
                    <td>
                      <RowLink href={`/history/${b.id}`} onClick={(e) => e.preventDefault()}>
                        {formatDateTime(b.finishedAt)}
                      </RowLink>
                    </td>
                    <td>
                      {strings.tableName(b.tableNumber)} #{b.boardNo}
                    </td>
                    <td>
                      {b.players.N.username}–{b.players.S.username}
                    </td>
                    <td>
                      {b.players.E.username}–{b.players.W.username}
                    </td>
                    <td>
                      <ContractLabel contract={b.contract} />
                    </td>
                    <td>{b.contract ? resultLabel(b.contract, b.result.declarerTricks) : '—'}</td>
                    <Num $value={b.result.scoreNS}>{signed(b.result.scoreNS)}</Num>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Scroll>
        )}
      </Card>
    </PageMain>
  )
}
