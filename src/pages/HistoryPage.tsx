import { ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { HISTORY_SORTS, historyQueryString, readHistoryQuery, type HistoryQuery } from '../../shared/history-query.ts'
import { HISTORY_PAGE_SIZES, LIMITS, type HistoryPage as Page, type PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { HistoryFilters } from '../components/HistoryFilters.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useLobby } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'

/**
 * BBO's history list: every finished board, newest first, a page at a time; the viewer picks how
 * many boards a page shows (remembered in the browser) and moves between numbered pages. Click a
 * board to open it. Filters and sorting (e4-t16…t21) live in the address, so reloading or sharing
 * the link shows the same list; the address is read with `readHistoryQuery` and written with
 * `historyQueryString`, the same rules the server checks.
 */

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-bottom: 16px;

  & > div:first-child { margin-bottom: 0; }
`

const FilterToggle = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $active }) => ($active ? theme.colors.surfaceAlt : theme.colors.surface)};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`

const FilterCard = styled(Card)`
  margin-bottom: 16px;
`

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
  /** The query string the page was loaded for */
  key: string
}

/** Filters set in a search, not counting scope, sorting and paging */
const filterCount = (query: HistoryQuery) =>
  Object.keys(query).filter((key) => !['scope', 'sort', 'page', 'size'].includes(key)).length

export function HistoryPage() {
  const { t, lang, message } = usePreferences()
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  const query = useMemo(() => {
    const read = readHistoryQuery(new URLSearchParams(paramsKey))
    return new URLSearchParams(paramsKey).has('size') ? read : { ...read, size: readSize() }
  }, [paramsKey])
  const all = query.scope === 'all'
  const { page, size } = query
  const key = historyQueryString(query)
  const [showFilters, setShowFilters] = useState(() => filterCount(query) > 0)
  // The list is tagged with what it was loaded for, so changing it shows "loading"
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const members = useLobby()?.members ?? []
  const current = loaded?.key === key ? loaded : null
  const last = loaded ? Math.max(1, Math.ceil(loaded.total / loaded.size)) : 1

  /** Changes the search in the address; anything but paging starts again from the first page */
  const update = (patch: Partial<HistoryQuery>) =>
    setParams(historyQueryString({ ...query, page: 1, ...patch }), { replace: true })
  const setPage = (next: number) => update({ page: next })

  useEffect(() => {
    let cancelled = false
    api
      .searchHistory(readHistoryQuery(new URLSearchParams(key)))
      .then((result) => {
        if (cancelled) return
        setError('')
        setLoaded({ key, ...result })
      })
      .catch((e) => !cancelled && setError(message(e.code, e.params, e.message)))
    return () => {
      cancelled = true
    }
  }, [key, message])

  // Past the end (the list got shorter): the server sent the last page instead
  useEffect(() => {
    if (current && current.page !== page) setParams(historyQueryString({ ...query, page: current.page }), { replace: true })
  }, [current, page, query, setParams])

  const chooseSize = (next: number) => {
    update({ size: next })
    try {
      window.localStorage.setItem(SIZE_KEY, String(next))
    } catch {
      // Not remembered; the list still changes
    }
  }

  const name = (u: PublicUser) => playerName(t, u)

  return (
    <PageMain>
      <PageTitle>{t.historyTitle}</PageTitle>
      <Toolbar>
        <Toggle role="group" aria-label={t.historyTitle}>
          <ToggleButton type="button" $active={!all} aria-pressed={!all} onClick={() => update({ scope: 'mine' })}>
            {t.historyMine}
          </ToggleButton>
          <ToggleButton type="button" $active={all} aria-pressed={all} onClick={() => update({ scope: 'all' })}>
            {t.historyAll}
          </ToggleButton>
        </Toggle>
        <FilterToggle
          type="button"
          $active={showFilters}
          aria-expanded={showFilters}
          aria-controls="history-filters"
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {t.filters}
          {filterCount(query) > 0 && ` (${filterCount(query)})`}
        </FilterToggle>
        <SizeLabel>
          {t.sortBy}
          <select value={query.sort} onChange={(e) => update({ sort: HISTORY_SORTS.find((s) => s === e.target.value) })}>
            {HISTORY_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t.sortNames[sort]}
              </option>
            ))}
          </select>
        </SizeLabel>
      </Toolbar>
      {showFilters && (
        <FilterCard id="history-filters" aria-label={t.filters}>
          <HistoryFilters query={query} members={members} onChange={update} />
        </FilterCard>
      )}
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
                      {b.mode === 'challenge' ? t.challenge : t.tableName(b.tableNumber)} #{b.boardNo}
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
