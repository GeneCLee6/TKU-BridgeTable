import { Inbox, SearchX, SlidersHorizontal } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import {
  HISTORY_MODES,
  HISTORY_SORTS,
  historyQueryString,
  readHistoryQuery,
  type HistoryMode,
  type HistoryQuery,
} from '../../shared/history-query.ts'
import type { HistoryPage as Page } from '../../shared/protocol.ts'
import { FilterChips, HistoryFilters } from '../components/HistoryFilters.tsx'
import {
  HistoryFrame,
  HistoryHead,
  HistoryRow,
  HistorySkeleton,
  HistoryTable,
} from '../components/HistoryRow.tsx'
import { Pager, SortSelect } from '../components/Pager.tsx'
import { GroupingSwitch, RecordGroups } from '../components/RecordGroups.tsx'
import { Button, Card, ErrorText, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { filterChips } from '../lib/historyChips.ts'
import { isGrouping, readPageSize, writePageSize, type RecordGrouping } from '../lib/lists.ts'
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
 * The boards are grouped as in the side panel's 紀錄 (`RecordGroups`, 社長 2026-10-27): by date
 * first, by topic first (一般牌桌, 挑戰, 隊制賽, 練習, then the dates), or not at all; the
 * grouping, and the topic and the date picked, are in the address too (`group`, `topic`, `day`).
 * The pager and the sort are the ones every list of records shares (`Pager.tsx`).
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

  & > div:first-child {
    margin-bottom: 0;
  }
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

  & > svg {
    color: ${({ theme }) => theme.colors.borderStrong};
  }
  & > p {
    margin: 0;
  }
`

/** How long the list may take before the page says so and offers to try again (DESIGN.md §7.6) */
const SLOW_MS = 10_000

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
  const { t } = usePreferences()
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  const query = useMemo(() => {
    const read = readHistoryQuery(new URLSearchParams(paramsKey))
    return new URLSearchParams(paramsKey).has('size') ? read : { ...read, size: readPageSize() }
  }, [paramsKey])
  const all = query.scope === 'all'
  const groups = readGroups(params)
  const phone = useMediaQuery(mobileQuery)
  // "Today" for the date chip is the day the page opened, as in the filters
  const [openedAt] = useState(Date.now)
  const members = useLobby()?.members ?? []
  const chips = filterChips(query, t, members, openedAt)
  // A link with filters opens them on a wide screen; a phone keeps them folded
  const [showFilters, setShowFilters] = useState(() => !phone && chips.length > 0)

  /** The address for a search and a place among the groups */
  const address = (next: HistoryQuery, place: Groups = groups) => {
    const out = new URLSearchParams(historyQueryString(next))
    if (place.grouping !== 'date') out.set('group', place.grouping)
    if (place.grouping === 'topic' && place.topic) out.set('topic', place.topic)
    if (place.grouping !== 'none' && place.day) out.set('day', place.day)
    return out.toString()
  }
  /** Paging, sorting and the page size keep the group on screen; the first two start from page 1 */
  const update = (patch: Partial<HistoryQuery>) =>
    setParams(address({ ...query, page: 1, ...patch }), { replace: true })
  /** Another search may not have the day picked: back to the dates (the topic stays) */
  const refilter = (patch: Partial<HistoryQuery>) =>
    setParams(address({ ...query, page: 1, ...patch }, { ...groups, day: null }), { replace: true })
  const move = (place: Groups) => setParams(address({ ...query, page: 1 }, place))

  const chooseSize = (next: number) => {
    update({ size: next })
    writePageSize(next)
  }

  const empty =
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

  return (
    <PageMain>
      <PageTitle>{t.historyTitle}</PageTitle>
      <Toolbar>
        <Toggle role="group" aria-label={t.historyTitle}>
          <ToggleButton
            type="button"
            $active={!all}
            aria-pressed={!all}
            onClick={() => refilter({ scope: 'mine' })}
          >
            {t.historyMine}
          </ToggleButton>
          <ToggleButton
            type="button"
            $active={all}
            aria-pressed={all}
            onClick={() => refilter({ scope: 'all' })}
          >
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
        <SortSelect
          value={query.sort}
          options={HISTORY_SORTS}
          names={t.sortNames}
          onChange={(sort) => update({ sort })}
        />
        <GroupingSwitch
          value={groups.grouping}
          onChange={(grouping) => move({ grouping, topic: null, day: null })}
        />
      </Toolbar>
      {showFilters && (
        <FilterCard id="history-filters" aria-label={t.filters}>
          <HistoryFilters query={query} members={members} onChange={refilter} now={openedAt} />
          {phone && (
            <Done>
              <Button type="button" $small onClick={() => setShowFilters(false)}>
                {t.filtersDone}
              </Button>
            </Done>
          )}
        </FilterCard>
      )}
      <FilterChips chips={chips} onChange={refilter} />
      <ListCard as="section" aria-label={t.historyTitle}>
        <RecordGroups
          query={query}
          grouping={groups.grouping}
          topic={groups.topic}
          day={groups.day}
          onTopic={(topic) => move({ ...groups, topic, day: null })}
          onDay={(day) => move({ ...groups, day })}
          empty={empty}
        >
          {(boards) => (
            <BoardPages
              query={boards}
              empty={empty}
              onPage={(page) => update({ page })}
              onSize={chooseSize}
            />
          )}
        </RecordGroups>
      </ListCard>
    </PageMain>
  )
}

/** Where the page is among the groups (DESIGN.md §7.4): in the address as `group`, `topic` and `day` */
interface Groups {
  grouping: RecordGrouping
  topic: HistoryMode | null
  day: string | null
}

function readGroups(params: URLSearchParams): Groups {
  const group = params.get('group')
  const day = params.get('day') ?? ''
  return {
    grouping: isGrouping(group) ? group : 'date',
    topic: HISTORY_MODES.find((m) => m === params.get('topic')) ?? null,
    day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
  }
}

/**
 * One group's boards (or every board, not grouped), a page at a time, as the table of DESIGN.md
 * §7.4; paging keeps the page on screen until the next one comes (e3-t46)
 */
function BoardPages({
  query,
  empty,
  onPage,
  onSize,
}: {
  query: HistoryQuery
  empty: ReactNode
  onPage: (page: number) => void
  onSize: (size: number) => void
}) {
  const { t, message } = usePreferences()
  const { page, size } = query
  const key = historyQueryString(query)
  // The list is tagged with what it was loaded for; until the next one comes, this one stays
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const cache = useRef<PageCache>({ search: '', pages: new Map() })
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const current = loaded?.key === key ? loaded : null
  // What is on screen: this search's page once it has come, the one before it until then
  const shown = current ?? loaded

  // Asked again from the "taking a while" message
  const [attempt, setAttempt] = useState(0)
  const [slowKey, setSlowKey] = useState<string | null>(null)
  const slow = slowKey === `${key}#${attempt}`
  useEffect(() => {
    const timer = setTimeout(() => setSlowKey(`${key}#${attempt}`), SLOW_MS)
    return () => clearTimeout(timer)
  }, [key, attempt])

  /** The page for a query string: from memory if this search already fetched it, else from the server */
  const fetchPage = useCallback((pageKey: string) => {
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
  }, [])

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
    if (current && current.page !== page) onPage(current.page)
  }, [current, page, onPage])

  return (
    <div aria-busy={!current}>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {shown && shown.boards.length === 0 ? (
        empty
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
      {loaded && (
        <Pager
          inCard
          label={t.historyTitle}
          page={page}
          size={loaded.size}
          total={loaded.total}
          onPage={onPage}
          onSize={onSize}
          onPrefetch={(next) =>
            fetchPage(historyQueryString({ ...query, page: next })).catch(() => {})
          }
        />
      )}
    </div>
  )
}
