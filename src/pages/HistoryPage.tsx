import { ChevronLeft, ChevronRight, Inbox, SearchX, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { HISTORY_SORTS, historyQueryString, readHistoryQuery, type HistoryQuery } from '../../shared/history-query.ts'
import { HISTORY_PAGE_SIZES, LIMITS, type HistoryPage as Page } from '../../shared/protocol.ts'
import { FilterChips, HistoryFilters } from '../components/HistoryFilters.tsx'
import { HistoryFrame, HistoryHead, HistoryRow, HistorySkeleton, HistoryTable } from '../components/HistoryRow.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { filterChips } from '../lib/historyChips.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useLobby } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile, mobileQuery } from '../styles/tokens.ts'

/**
 * BBO's history list: every finished board, newest first, a page at a time; the viewer picks how
 * many boards a page shows (remembered in the browser) and moves between numbered pages. Click a
 * board to open it. Filters and sorting (e4-t16…t21) live in the address, so reloading or sharing
 * the link shows the same list; the address is read with `readHistoryQuery` and written with
 * `historyQueryString`, the same rules the server checks. The conditions in use show as chips
 * above the list, each removable, with "clear all" (e4-t22); on a phone the filters fold into the
 * one "Filters" button and open only when asked for.
 *
 * Moving between pages does not blank the list (e3-t46): the page on screen stays (faintly, if the
 * next one takes a moment) until the next one has come, pages already fetched for the same search
 * are kept in memory, and pointing at a page button fetches that page before it is pressed. Only the
 * very first load shows grey rows.
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

  ${mobile} {
    padding: 14px;
  }
`

const Done = styled.div`
  display: flex;
  justify-content: flex-end;
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

const ListCard = styled(Card)`
  padding: 0;
  overflow: hidden;
`

/** The list on screen while the next one loads: dimmed only if the wait is long enough to notice */
const Rows = styled.div<{ $stale: boolean }>`
  opacity: ${({ $stale }) => ($stale ? 0.6 : 1)};
  transition: opacity 0.15s ${({ $stale }) => ($stale ? '0.15s' : '0s')};
`

/** An empty or failed list: centred, a faint icon, one sentence and (where there is one) an action */
const Empty = styled.div`
  display: grid;
  justify-items: center;
  gap: ${({ theme }) => theme.space(3)};
  padding: ${({ theme }) => theme.space(12)} ${({ theme }) => theme.space(4)};
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: center;

  & > svg { color: ${({ theme }) => theme.colors.borderStrong}; }
  & > p { margin: 0; }
`

/** How long the list may take before the page says so and offers to try again (DESIGN.md §7.6) */
const SLOW_MS = 10_000

const Pager = styled.nav`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
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

/** Pages kept for one search (everything but the page number); another search starts afresh */
interface PageCache {
  search: string
  pages: Map<string, Promise<Page>>
}

/** The search a query string is for, leaving out which page */
const searchOf = (key: string) => {
  const params = new URLSearchParams(key)
  params.delete('page')
  return params.toString()
}

export function HistoryPage() {
  const { t, message } = usePreferences()
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  const query = useMemo(() => {
    const read = readHistoryQuery(new URLSearchParams(paramsKey))
    return new URLSearchParams(paramsKey).has('size') ? read : { ...read, size: readSize() }
  }, [paramsKey])
  const all = query.scope === 'all'
  const { page, size } = query
  const key = historyQueryString(query)
  const phone = useMediaQuery(mobileQuery)
  // "Today" for the date chip is the day the page opened, as in the filters
  const [openedAt] = useState(Date.now)
  const members = useLobby()?.members ?? []
  const chips = filterChips(query, t, members, openedAt)
  // A link with filters opens them on a wide screen; a phone keeps them folded
  const [showFilters, setShowFilters] = useState(() => !phone && chips.length > 0)
  // The list is tagged with what it was loaded for; until the next one comes, this one stays
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const cache = useRef<PageCache>({ search: '', pages: new Map() })
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const current = loaded?.key === key ? loaded : null
  // What is on screen: this search's page once it has come, the one before it until then
  const shown = current ?? loaded
  const last = loaded ? Math.max(1, Math.ceil(loaded.total / loaded.size)) : 1

  /** Changes the search in the address; anything but paging starts again from the first page */
  const update = (patch: Partial<HistoryQuery>) =>
    setParams(historyQueryString({ ...query, page: 1, ...patch }), { replace: true })
  const setPage = (next: number) => update({ page: next })

  // Asked again from the "taking a while" message
  const [attempt, setAttempt] = useState(0)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const slow = slowKey === `${key}#${attempt}`
  useEffect(() => {
    const timer = setTimeout(() => setSlowKey(`${key}#${attempt}`), SLOW_MS)
    return () => clearTimeout(timer)
  }, [key, attempt])

  /** The page for a query string: from memory if this search already fetched it, else from the server */
  const fetchPage = useCallback(
    (pageKey: string) => {
      const search = searchOf(pageKey)
      const kept = cache.current
      if (kept.search !== search) {
        kept.search = search
        kept.pages.clear()
      }
      let pending = kept.pages.get(pageKey)
      if (!pending) {
        const asked = api.searchHistory(readHistoryQuery(new URLSearchParams(pageKey)))
        kept.pages.set(pageKey, asked)
        // A failed page is asked again next time
        asked.catch(() => kept.pages.get(pageKey) === asked && kept.pages.delete(pageKey))
        pending = asked
      }
      return pending
    },
    [],
  )

  /** Fetches a page the pointer is on, so pressing it shows it at once */
  const prefetch = (next: number) => {
    if (next < 1 || next > last || next === page) return
    fetchPage(historyQueryString({ ...query, page: next })).catch(() => {})
  }

  useEffect(() => {
    let cancelled = false
    fetchPage(key)
      .then((result) => {
        if (cancelled) return
        setError('')
        setLoaded({ key, ...result })
      })
      .catch((e) => !cancelled && setError(message(e.code, e.params, e.message)))
    return () => {
      cancelled = true
    }
  }, [key, message, attempt, fetchPage])

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
          {chips.length > 0 && ` (${chips.length})`}
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
          <HistoryFilters query={query} members={members} onChange={update} now={openedAt} />
          {phone && (
            <Done>
              <Button type="button" $small onClick={() => setShowFilters(false)}>
                {t.filtersDone}
              </Button>
            </Done>
          )}
        </FilterCard>
      )}
      <FilterChips chips={chips} onChange={update} />
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <ListCard as="section" aria-label={t.historyTitle} aria-busy={!current}>
        {shown && shown.boards.length === 0 ? (
          chips.length > 0 ? (
            <Empty>
              <SearchX size={40} aria-hidden />
              {/* "Clear all" is right above, with the chips */}
              <p>{t.historyNoMatch}</p>
            </Empty>
          ) : (
            <Empty>
              <Inbox size={40} aria-hidden />
              <p>{t.historyEmpty}</p>
              <Button as={Link} to="/" $size="sm" $variant="primary">
                {t.goToLobby}
              </Button>
            </Empty>
          )
        ) : !current && slow ? (
          <Empty role="status">
            <p>{t.slowLoading}</p>
            <Button
              type="button"
              $size="sm"
              onClick={() => {
                cache.current.pages.delete(key)
                setAttempt((n) => n + 1)
              }}
            >
              {t.retry}
            </Button>
          </Empty>
        ) : (
          <HistoryFrame>
            <Rows $stale={!current}>
              <HistoryTable>
                <HistoryHead />
                {shown ? (
                  <tbody>
                    {shown.boards.map((b) => (
                      <HistoryRow key={b.id} board={b} onOpen={(id) => navigate(`/history/${id}`)} />
                    ))}
                  </tbody>
                ) : (
                  <HistorySkeleton rows={Math.min(size, 10)} />
                )}
              </HistoryTable>
            </Rows>
          </HistoryFrame>
        )}
        {loaded && loaded.total > 0 && (
          <Pager aria-label={t.historyTitle}>
            <Muted>
              {t.pageInfo(Math.min(loaded.total, (loaded.page - 1) * loaded.size + 1), Math.min(loaded.total, loaded.page * loaded.size), loaded.total)}
            </Muted>
            <Pages>
              <PageButton
                type="button"
                onClick={() => setPage(page - 1)}
                onPointerEnter={() => prefetch(page - 1)}
                onFocus={() => prefetch(page - 1)}
                disabled={page <= 1}
                aria-label={t.prevPage}
                title={t.prevPage}
              >
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
                    onPointerEnter={() => prefetch(n)}
                    onFocus={() => prefetch(n)}
                  >
                    {n}
                  </PageButton>
                ),
              )}
              <PageButton
                type="button"
                onClick={() => setPage(page + 1)}
                onPointerEnter={() => prefetch(page + 1)}
                onFocus={() => prefetch(page + 1)}
                disabled={page >= last}
                aria-label={t.nextPage}
                title={t.nextPage}
              >
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
      </ListCard>
    </PageMain>
  )
}
