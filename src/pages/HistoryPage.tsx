import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { HISTORY_PAGE_SIZES, LIMITS, type HistoryPage as Page, type PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { ContractLabel } from '../components/Suit.tsx'
import { Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * BBO's history list: every finished board, newest first, a page at a time; the viewer picks how
 * many boards a page shows (remembered in the browser) and moves between numbered pages. Click a
 * board to open it.
 */

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

const Pager = styled.nav`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 14px;
  font-size: 14px;
`

const Pages = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
`

const PageButton = styled.button<{ $current?: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 34px;
  padding: 0 6px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $current }) => ($current ? theme.colors.primary : theme.colors.surface)};
  color: ${({ theme, $current }) => ($current ? theme.colors.onPrimary : theme.colors.text)};
  font-weight: 600;
  &:disabled { opacity: 0.4; }
`

const SizeLabel = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: ${({ theme }) => theme.colors.textMuted};

  & > select {
    min-height: 34px;
    padding: 0 6px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.surface};
    color: ${({ theme }) => theme.colors.text};
    font-size: 14px;
  }
`

const SIZE_KEY = 'tku-bridge-table:history-size'

function readSize(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIZE_KEY))
    return (HISTORY_PAGE_SIZES as readonly number[]).includes(stored) ? stored : LIMITS.historyPageDefault
  } catch {
    return LIMITS.historyPageDefault
  }
}

/** Page numbers to offer: the first, the last and two either side of the current one, with gaps */
function pageNumbers(page: number, last: number): (number | null)[] {
  const wanted = [...new Set([1, last, ...[-2, -1, 0, 1, 2].map((d) => page + d)])]
    .filter((n) => n >= 1 && n <= last)
    .sort((a, b) => a - b)
  return wanted.flatMap((n, i) => (i > 0 && n - wanted[i - 1] > 1 ? [null, n] : [n]))
}

interface Loaded extends Page {
  all: boolean
}

export function HistoryPage() {
  const { t, lang, message } = usePreferences()
  const [all, setAll] = useState(false)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(readSize)
  // The list is tagged with what it was loaded for, so changing it shows "loading"
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const current = loaded?.all === all && loaded.page === page && loaded.size === size ? loaded : null
  const last = loaded ? Math.max(1, Math.ceil(loaded.total / loaded.size)) : 1

  useEffect(() => {
    let cancelled = false
    api
      .history(all, page, size)
      .then((result) => {
        if (cancelled) return
        setLoaded({ all, ...result })
        // Past the end (the list got shorter): the server sent the last page instead
        if (result.page !== page) setPage(result.page)
      })
      .catch((e) => !cancelled && setError(message(e.code, e.params, e.message)))
    return () => {
      cancelled = true
    }
  }, [all, page, size, message])

  const chooseSize = (next: number) => {
    setSize(next)
    setPage(1)
    try {
      window.localStorage.setItem(SIZE_KEY, String(next))
    } catch {
      // Not remembered; the list still changes
    }
  }

  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)

  return (
    <PageMain>
      <PageTitle>{t.historyTitle}</PageTitle>
      <Toggle role="group" aria-label={t.historyTitle}>
        <ToggleButton
          type="button"
          $active={!all}
          aria-pressed={!all}
          onClick={() => {
            setAll(false)
            setPage(1)
          }}
        >
          {t.historyMine}
        </ToggleButton>
        <ToggleButton
          type="button"
          $active={all}
          aria-pressed={all}
          onClick={() => {
            setAll(true)
            setPage(1)
          }}
        >
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
        {loaded && loaded.total > 0 && (
          <Pager aria-label={t.historyTitle}>
            <Muted>
              {t.pageInfo(Math.min(loaded.total, (loaded.page - 1) * loaded.size + 1), Math.min(loaded.total, loaded.page * loaded.size), loaded.total)}
            </Muted>
            <Pages>
              <PageButton type="button" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label={t.prevPage} title={t.prevPage}>
                <ChevronLeft size={16} aria-hidden />
              </PageButton>
              {pageNumbers(page, last).map((n, i) =>
                n === null ? (
                  <Muted key={`gap${i}`} aria-hidden>
                    …
                  </Muted>
                ) : (
                  <PageButton
                    key={n}
                    type="button"
                    $current={n === page}
                    aria-current={n === page ? 'page' : undefined}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </PageButton>
                ),
              )}
              <PageButton type="button" onClick={() => setPage(page + 1)} disabled={page >= last} aria-label={t.nextPage} title={t.nextPage}>
                <ChevronRight size={16} aria-hidden />
              </PageButton>
            </Pages>
            <SizeLabel>
              {t.perPage}
              <select value={size} onChange={(e) => chooseSize(Number(e.target.value))}>
                {HISTORY_PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </SizeLabel>
          </Pager>
        )}
      </Card>
    </PageMain>
  )
}
