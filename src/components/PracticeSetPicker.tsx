import { useEffect, useState } from 'react'
import styled from 'styled-components'
import type { FeaturedBoard } from '../../shared/featured.ts'
import { PRACTICE_SET_BOARDS_MAX, PRACTICE_SET_SOURCES, type PracticeSetChoice } from '../../shared/practice.ts'
import type { PracticeSetInfo } from '../../shared/practice-sets/types.ts'
import type { BoardSummary } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * Which deal set to practise (`e10-t16`): one of the club's practice sets, or boards of the member's
 * favourites or of the featured list, ticked one by one. Only names and board numbers come here:
 * the server deals the boards, and only those the member may see and that are already public (§4).
 */

const Box = styled.div`
  display: grid;
  gap: 10px;
  padding: 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  font-size: 14px;
`

const Sources = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;

  & > label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
`

const List = styled.ul`
  display: grid;
  gap: 4px;
  max-height: 200px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;

  & label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
`

const Tools = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;
`

type Source = (typeof PRACTICE_SET_SOURCES)[number]
interface Item {
  id: string
  label: string
}

export function PracticeSetPicker({ value, onChange }: { value: PracticeSetChoice | undefined; onChange: (set: PracticeSetChoice | undefined) => void }) {
  const { t, lang } = usePreferences()
  const [source, setSource] = useState<Source>(value?.source ?? 'practice')
  const [items, setItems] = useState<Partial<Record<Source, Item[]>>>({})

  useEffect(() => {
    if (items[source]) return
    let live = true
    const load = async (): Promise<Item[]> => {
      if (source === 'practice') {
        const { sets } = await api.practiceSets()
        return sets.map((set: PracticeSetInfo) => ({
          id: set.id,
          label: `${t.practiceSetNames[set.id] ?? set.id} · ${t.practiceSetCount(set.count)}`,
        }))
      }
      if (source === 'favorites') {
        const page = await api.favorites({ page: 1, size: PRACTICE_SET_BOARDS_MAX })
        return page.boards.map((b: BoardSummary) => ({ id: b.id, label: t.practiceSetBoard(b.boardNo, formatDate(b.finishedAt, lang)) }))
      }
      const { featured } = await api.featured()
      return featured.map((f: FeaturedBoard) => ({ id: f.boardId, label: `${f.title} · ${t.practiceSetBoard(f.board.boardNo, formatDate(f.board.finishedAt, lang))}` }))
    }
    load()
      .catch(() => [])
      .then((loaded) => {
        if (!live) return
        setItems((before) => ({ ...before, [source]: loaded }))
        // A practice set to begin with, so the dialog can open at once
        if (source === 'practice' && !value && loaded.length) onChange({ source: 'practice', id: loaded[0].id })
      })
    return () => {
      live = false
    }
  }, [source, items, t, lang, value, onChange])

  const list = items[source]
  const picked = value && value.source !== 'practice' && value.source === source ? value.ids : []
  const pick = (ids: string[]) => onChange(ids.length ? { source: source as 'favorites' | 'featured', ids: ids.slice(0, PRACTICE_SET_BOARDS_MAX) } : undefined)

  return (
    <Box>
      <Sources role="radiogroup" aria-label={t.practiceSetLegend}>
        {PRACTICE_SET_SOURCES.map((s) => (
          <label key={s}>
            <input
              type="radio"
              name="practice-set-source"
              checked={source === s}
              onChange={() => {
                setSource(s)
                const first = items[s]?.[0]
                onChange(s === 'practice' && first ? { source: 'practice', id: first.id } : undefined)
              }}
            />
            {t.practiceSetSources[s]}
          </label>
        ))}
      </Sources>
      {!list ? (
        <Muted>{t.practiceSetLoading}</Muted>
      ) : list.length === 0 ? (
        <Muted>{t.practiceSetEmpty[source]}</Muted>
      ) : source === 'practice' ? (
        <List>
          {list.map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="radio"
                  name="practice-set"
                  checked={value?.source === 'practice' && value.id === item.id}
                  onChange={() => onChange({ source: 'practice', id: item.id })}
                />
                {item.label}
              </label>
            </li>
          ))}
        </List>
      ) : (
        <>
          <Tools>
            <Button type="button" $size="sm" onClick={() => pick(list.map((item) => item.id))}>
              {t.practiceSetPickAll}
            </Button>
            <Button type="button" $size="sm" onClick={() => pick([])}>
              {t.practiceSetPickNone}
            </Button>
            <Muted>{t.practiceSetPicked(picked.length, PRACTICE_SET_BOARDS_MAX)}</Muted>
          </Tools>
          <List>
            {list.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.includes(item.id)}
                    onChange={(event) =>
                      pick(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))
                    }
                  />
                  {item.label}
                </label>
              </li>
            ))}
          </List>
        </>
      )}
      <Muted>{t.practiceSetHint}</Muted>
    </Box>
  )
}
