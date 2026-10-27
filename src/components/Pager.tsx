import { ChevronLeft, ChevronRight } from 'lucide-react'
import styled, { css } from 'styled-components'
import { HISTORY_PAGE_SIZES } from '../../shared/protocol.ts'
import { pageNumbers } from '../lib/lists.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Muted } from './ui.tsx'

/**
 * The pages and the sort of every list of records (DESIGN.md §7.4, 社長 2026-10-27): 牌局紀錄,
 * 我的收藏, 精選牌局, 挑戰 and 隊制賽 all use these two, so they look and work the same. The pager
 * says which items are shown, offers the first, the last and two pages either side of the current
 * one, and how many a page shows (`onSize`, remembered with `writePageSize`). Pointing at a page
 * button calls `onPrefetch`, so a list from the server can fetch it before it is pressed.
 */

const Bar = styled.nav<{ $inCard: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  font-size: 14px;

  ${({ $inCard, theme }) =>
    $inCard
      ? css`
          border-top: 1px solid ${theme.colors.border};
        `
      : css`
          margin-top: ${theme.space(4)};
          border: 1px solid ${theme.colors.border};
          border-radius: ${theme.radius.md};
        `}
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
  &:disabled {
    opacity: 0.4;
  }
`

/** A label with a small select after it: the sort, and how many a page shows */
export const SelectLabel = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;

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

export function Pager({
  page,
  size,
  total,
  onPage,
  onSize,
  onPrefetch,
  label,
  inCard = false,
  items = false,
}: {
  page: number
  size: number
  total: number
  onPage: (page: number) => void
  onSize?: (size: number) => void
  onPrefetch?: (page: number) => void
  /** Names the pager for a screen reader: the list's name */
  label: string
  /** The pager closes a card (a ruled line above it) rather than standing on its own */
  inCard?: boolean
  /** Counts items (challenges, matches) rather than boards */
  items?: boolean
}) {
  const { t } = usePreferences()
  if (total <= 0) return null
  const last = Math.max(1, Math.ceil(total / size))
  const prefetch = (n: number) => {
    if (onPrefetch && n >= 1 && n <= last && n !== page) onPrefetch(n)
  }
  const go = (n: number) => ({
    onClick: () => onPage(n),
    onPointerEnter: () => prefetch(n),
    onFocus: () => prefetch(n),
  })
  return (
    <Bar aria-label={label} $inCard={inCard}>
      <Muted>
        {(items ? t.listPageInfo : t.pageInfo)(
          Math.min(total, (page - 1) * size + 1),
          Math.min(total, page * size),
          total,
        )}
      </Muted>
      <Pages>
        <PageButton
          type="button"
          {...go(page - 1)}
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
              {...go(n)}
            >
              {n}
            </PageButton>
          ),
        )}
        <PageButton
          type="button"
          {...go(page + 1)}
          disabled={page >= last}
          aria-label={t.nextPage}
          title={t.nextPage}
        >
          <ChevronRight size={16} aria-hidden />
        </PageButton>
      </Pages>
      {onSize && (
        <SelectLabel>
          {t.perPage}
          <select value={size} onChange={(e) => onSize(Number(e.target.value))}>
            {HISTORY_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </SelectLabel>
      )}
    </Bar>
  )
}

/** 「排序」 and its choices; `names` gives each its words */
export function SortSelect<T extends string>({
  value,
  options,
  names,
  onChange,
}: {
  value: T
  options: readonly T[]
  names: Record<T, string>
  onChange: (value: T) => void
}) {
  const { t } = usePreferences()
  return (
    <SelectLabel>
      {t.sortBy}
      <select
        value={value}
        onChange={(e) => onChange(options.find((o) => o === e.target.value) ?? value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {names[o]}
          </option>
        ))}
      </select>
    </SelectLabel>
  )
}
