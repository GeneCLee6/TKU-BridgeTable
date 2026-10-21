import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled, { css } from 'styled-components'
import type { BoardSummary, PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { ContractLabel } from '../components/Suit.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/** BBO's history list: every finished board, newest first, fifty at a time; click one to open it */

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

const More = styled.div`
  display: flex;
  justify-content: center;
  margin-top: 12px;
`

interface Loaded {
  all: boolean
  boards: BoardSummary[]
  next: string | null
}

export function HistoryPage() {
  const { t, lang, message } = usePreferences()
  const [all, setAll] = useState(false)
  // The list is tagged with the scope it was loaded for, so switching scope shows "loading"
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const current = loaded?.all === all ? loaded : null

  useEffect(() => {
    let cancelled = false
    api
      .history(all)
      .then((page) => !cancelled && setLoaded({ all, ...page }))
      .catch((e) => !cancelled && setError(message(e.code, e.params, e.message)))
    return () => {
      cancelled = true
    }
  }, [all, message])

  const loadMore = async () => {
    if (!current?.next) return
    setBusy(true)
    try {
      const page = await api.history(all, current.next)
      setLoaded({ all, boards: [...current.boards, ...page.boards], next: page.next })
    } finally {
      setBusy(false)
    }
  }

  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)

  return (
    <PageMain>
      <PageTitle>{t.historyTitle}</PageTitle>
      <Toggle role="group" aria-label={t.historyTitle}>
        <ToggleButton type="button" $active={!all} aria-pressed={!all} onClick={() => setAll(false)}>
          {t.historyMine}
        </ToggleButton>
        <ToggleButton type="button" $active={all} aria-pressed={all} onClick={() => setAll(true)}>
          {t.historyAll}
        </ToggleButton>
      </Toggle>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Card>
        {!current ? (
          <Muted>{t.loading}</Muted>
        ) : current.boards.length === 0 ? (
          <Muted>{t.historyEmpty}</Muted>
        ) : (
          <Scroll>
            <Table>
              <thead>
                <tr>
                  <th>{t.date}</th>
                  <th>{t.board}</th>
                  <th>{t.ns}</th>
                  <th>{t.ew}</th>
                  <th>{t.contract}</th>
                  <th>{t.result}</th>
                  <th style={{ textAlign: 'right' }}>{t.scoreNS}</th>
                </tr>
              </thead>
              <tbody>
                {current.boards.map((b) => (
                  <tr key={b.id} onClick={() => navigate(`/history/${b.id}`)}>
                    <td>{formatDateTime(b.finishedAt, lang)}</td>
                    <td>
                      {t.tableName(b.tableNumber)} #{b.boardNo}
                    </td>
                    <td>
                      {name(b.players.N)}–{name(b.players.S)}
                    </td>
                    <td>
                      {name(b.players.E)}–{name(b.players.W)}
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
        {current?.next && (
          <More>
            <Button type="button" onClick={() => void loadMore()} disabled={busy}>
              {t.loadMore}
            </Button>
          </More>
        )}
      </Card>
    </PageMain>
  )
}
