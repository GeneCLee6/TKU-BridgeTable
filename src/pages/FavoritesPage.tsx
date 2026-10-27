import { SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import {
  HISTORY_SORTS,
  historyQueryString,
  readHistoryQuery,
  type HistoryQuery,
} from '../../shared/history-query.ts'
import type { Favorite, FavoritesPage as Page } from '../../shared/protocol.ts'
import { Chip, ChipCount, ChipLabel, ChipStrip } from '../components/Chips.tsx'
import { FavoriteButton } from '../components/FavoriteButton.tsx'
import { FavoriteNotes } from '../components/FavoriteNotes.tsx'
import { FilterChips, HistoryFilters } from '../components/HistoryFilters.tsx'
import { Pager, SortSelect } from '../components/Pager.tsx'
import { ContractResult } from '../components/Suit.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useFavoriteIds } from '../lib/favorites.ts'
import { filterChips } from '../lib/historyChips.ts'
import { readPageSize, writePageSize } from '../lib/lists.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useLobby } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { boardPlace } from '../strings.ts'

/**
 * 「我的收藏」 (e4-t26, AC-4.4): the boards the member keeps, whoever played them, with the same
 * filters, chips and sorting as the history list plus a tag filter; all of it in the address as on
 * the history page. Each board shows its private note and tags, edited in place (e4-t27). The
 * server leaves out boards not revealed yet (AC-4.9), as everywhere else.
 */

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  margin-bottom: 16px;
`

const TagRow = styled(ChipStrip)`
  margin-bottom: 16px;
`

const FilterCard = styled(Card)`
  margin-bottom: 16px;
`

const Items = styled.ul`
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Item = styled.li`
  display: grid;
  gap: 8px;
  padding: 12px 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  &:last-child {
    border-bottom: 0;
  }
`

const Head = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  font-size: 15px;

  & > a {
    color: ${({ theme }) => theme.colors.text};
    font-weight: 600;
  }
`

const Score = styled.span<{ $value: number }>`
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: ${({ $value, theme }) => ($value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger)};
`

interface Loaded extends Page {
  key: string
}

export function FavoritesPage() {
  const { t, lang, message } = usePreferences()
  const [params, setParams] = useSearchParams()
  const paramsKey = params.toString()
  // Favorites are listed whoever played them: "all" only words the player filter that way
  const query = useMemo(() => {
    const read = readHistoryQuery(new URLSearchParams(paramsKey))
    const size = new URLSearchParams(paramsKey).has('size') ? read.size : readPageSize()
    return { ...read, size, scope: 'all' as const }
  }, [paramsKey])
  const key = historyQueryString(query)
  const [openedAt] = useState(Date.now)
  const members = useLobby()?.members ?? []
  const chips = filterChips(query, t, members, openedAt)
  const [showFilters, setShowFilters] = useState(false)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [edited, setEdited] = useState<Record<string, Favorite>>({})
  const [error, setError] = useState('')
  const kept = useFavoriteIds()
  const current = loaded?.key === key ? loaded : null

  // Anything but paging starts again from the first page; the scope is not part of the address here
  const update = (patch: Partial<HistoryQuery>) =>
    setParams(historyQueryString({ ...query, page: 1, ...patch, scope: 'mine' }), { replace: true })
  // Saving a note reads the list again, so the tag counts follow
  const [reload, setReload] = useState(0)

  useEffect(() => {
    let cancelled = false
    api
      .favorites(readHistoryQuery(new URLSearchParams(key)))
      .then((result) => {
        if (cancelled) return
        setError('')
        setLoaded({ key, ...result })
      })
      .catch((e) => !cancelled && setError(message(e.code, e.params, e.message)))
    return () => {
      cancelled = true
    }
  }, [key, message, reload])

  const favoriteOf = (id: string) => edited[id] ?? current?.favorites.find((f) => f.boardId === id)
  // A star pressed off here takes the board out of the list at once
  const boards = current?.boards.filter((b) => !kept || kept.has(b.id)) ?? []
  const tags = loaded?.tags ?? []

  return (
    <PageMain>
      <PageTitle>{t.favoritesTitle}</PageTitle>
      <Toolbar>
        <Chip
          type="button"
          $active={showFilters}
          aria-expanded={showFilters}
          onClick={() => setShowFilters(!showFilters)}
        >
          <SlidersHorizontal size={16} aria-hidden />
          {t.filters}
          {chips.length > 0 && <ChipCount n={chips.length} />}
        </Chip>
        <SortSelect
          value={query.sort}
          options={HISTORY_SORTS}
          names={t.sortNames}
          onChange={(sort) => update({ sort })}
        />
      </Toolbar>
      {tags.length > 0 && (
        <TagRow role="group" aria-label={t.filterTag}>
          <Chip
            type="button"
            $active={!query.tag}
            aria-pressed={!query.tag}
            onClick={() => update({ tag: undefined })}
          >
            {t.favoriteTagsAll}
          </Chip>
          {tags.map(({ tag, count }) => {
            const on = query.tag?.toLowerCase() === tag.toLowerCase()
            return (
              <Chip
                key={tag}
                type="button"
                $active={on}
                aria-pressed={on}
                onClick={() => update({ tag: on ? undefined : tag })}
              >
                <ChipLabel title={tag}>{tag}</ChipLabel>
                <ChipCount n={count} />
              </Chip>
            )
          })}
        </TagRow>
      )}
      {showFilters && (
        <FilterCard aria-label={t.filters}>
          <HistoryFilters query={query} members={members} onChange={update} now={openedAt} />
          <Button type="button" $small onClick={() => setShowFilters(false)}>
            {t.filtersDone}
          </Button>
        </FilterCard>
      )}
      <FilterChips chips={chips} onChange={update} />
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Card>
        {!current ? (
          <Muted>{t.loading}</Muted>
        ) : boards.length === 0 ? (
          <Muted>{chips.length > 0 ? t.favoritesNoMatch : t.favoritesEmpty}</Muted>
        ) : (
          <Items>
            {boards.map((b) => {
              const favorite = favoriteOf(b.id)
              return (
                <Item key={b.id}>
                  <Head>
                    <FavoriteButton boardId={b.id} />
                    <Link to={`/history/${b.id}`}>
                      {boardPlace(t, b)} #{b.boardNo}
                    </Link>
                    <ContractResult contract={b.contract} tricks={b.result.declarerTricks} />
                    <Score $value={b.result.scoreNS}>NS {signed(b.result.scoreNS)}</Score>
                    <Muted as="span">{formatDateTime(b.finishedAt, lang)}</Muted>
                  </Head>
                  {favorite && (
                    <FavoriteNotes
                      favorite={favorite}
                      known={tags}
                      onSaved={(saved) => {
                        setEdited((all) => ({ ...all, [saved.boardId]: saved }))
                        setReload((n) => n + 1)
                      }}
                    />
                  )}
                </Item>
              )
            })}
          </Items>
        )}
        {loaded && (
          <Pager
            label={t.favoritesTitle}
            page={loaded.page}
            size={loaded.size}
            total={loaded.total}
            onPage={(page) => update({ page })}
            onSize={(size) => {
              writePageSize(size)
              update({ size })
            }}
          />
        )}
      </Card>
    </PageMain>
  )
}
