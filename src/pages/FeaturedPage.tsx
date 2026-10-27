import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import styled, { css } from 'styled-components'
import {
  FEATURED_CATEGORIES,
  type FeaturedBoard,
  type FeaturedCategory,
} from '../../shared/featured.ts'
import { Pager, SortSelect } from '../components/Pager.tsx'
import { ContractResult } from '../components/Suit.tsx'
import { ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { paginate, sortList } from '../lib/lists.ts'
import { useListParams } from '../lib/useListParams.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { cardHover } from '../styles/controls.ts'

/**
 * 精選牌局 (AC-4.5, `e4-t30`): every featured board, newest first, in tabs by category. Each card
 * shows the title, the contract and result, who featured it and when, and opens the board's
 * record, where the explanation and the trick-by-trick notes are (`FeaturedPanel`). Newest or
 * oldest first, a page at a time (`Pager`, as every list of records).
 */

const SORTS = ['newest', 'oldest'] as const

type Tab = 'all' | FeaturedCategory

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-bottom: 16px;
`

const Tabs = styled.div`
  display: inline-flex;
  flex-wrap: wrap;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  overflow: hidden;
`

const TabButton = styled.button<{ $active: boolean }>`
  min-height: 36px;
  padding: 0 16px;
  border: 0;
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  ${({ $active, theme }) =>
    $active &&
    css`
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
`

const Grid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const CardLink = styled(Link)`
  display: grid;
  gap: 6px;
  height: 100%;
  padding: 14px 16px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;
  ${cardHover()}

  & > strong {
    font-size: 16px;
  }
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
`

export function FeaturedPage() {
  const { t, lang, message } = usePreferences()
  const [list, setList] = useState<FeaturedBoard[] | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const listing = useListParams(SORTS, 'newest')

  useEffect(() => {
    api
      .featured()
      .then((r) => setList(r.featured))
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [message])

  const count = (k: Tab) => (list ?? []).filter((f) => k === 'all' || f.category === k).length
  const inTab = sortList(
    (list ?? []).filter((f) => tab === 'all' || f.category === tab),
    listing.sort,
    (f) => f.at,
  )
  const { items: shown, page, total } = paginate(inTab, listing.page, listing.size)
  const tabs: Tab[] = ['all', ...FEATURED_CATEGORIES]
  return (
    <PageMain>
      <PageTitle>{t.featuredTitle}</PageTitle>
      <Toolbar>
        <Tabs role="tablist" aria-label={t.featuredTitle}>
          {tabs.map((k) => (
            <TabButton
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              $active={tab === k}
              onClick={() => {
                setTab(k)
                listing.firstPage()
              }}
            >
              {k === 'all' ? t.featuredAll : t.featuredCategories[k]}
              {list ? ` (${count(k)})` : ''}
            </TabButton>
          ))}
        </Tabs>
        <SortSelect
          value={listing.sort}
          options={SORTS}
          names={t.listSorts}
          onChange={listing.setSort}
        />
      </Toolbar>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!list && !error && <Muted>{t.loading}</Muted>}
      {list && shown.length === 0 && <Muted>{t.noFeatured}</Muted>}
      {shown.length > 0 && (
        <Grid
          role="tabpanel"
          aria-label={tab === 'all' ? t.featuredAll : t.featuredCategories[tab]}
        >
          {shown.map((f) => (
            <li key={f.boardId}>
              <CardLink to={`/history/${encodeURIComponent(f.boardId)}`}>
                <strong>{f.title}</strong>
                <ContractResult
                  contract={f.board.contract}
                  tricks={f.board.result.declarerTricks}
                />
                <small>
                  {t.featuredCategories[f.category]} · {t.tableName(f.board.tableNumber)} ·{' '}
                  {t.boardNo(f.board.boardNo)}
                </small>
                <small>{t.featuredBy(f.by.username, formatDateTime(f.at, lang))}</small>
              </CardLink>
            </li>
          ))}
        </Grid>
      )}
      <Pager
        label={t.featuredTitle}
        page={page}
        size={listing.size}
        total={total}
        onPage={listing.setPage}
        onSize={listing.setSize}
      />
    </PageMain>
  )
}
