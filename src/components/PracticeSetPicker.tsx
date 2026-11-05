import { useCallback, useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'
import type { FeaturedBoard } from '../../shared/featured.ts'
import { PRACTICE_SET_BOARDS_MAX, PRACTICE_SET_SOURCES, type PracticeSetChoice } from '../../shared/practice.ts'
import type { PracticeSetInfo } from '../../shared/practice-sets/types.ts'
import { IMPORT_LIMITS } from '../../shared/imports.ts'
import { parsePbn } from '../../shared/pbn-import.ts'
import type { BoardSummary, OwnDealInfo } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ImportProblems, ImportSource } from './ImportSource.tsx'
import { Button, ErrorText, Muted } from './ui.tsx'

/**
 * Which deal set to practise (`e10-t16`): one of the club's practice sets, or boards of the member's
 * favourites, of the featured list or of their own deals, ticked one by one. Only names and board
 * numbers come here: the server deals the boards, and only those the member may see and that are
 * already public (§4). The own deals come from PBN (`e10-t09`), read here and checked by the server.
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

const Import = styled.div`
  display: grid;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
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
  const ownItems = useCallback(
    (deals: OwnDealInfo[]): Item[] => deals.map((d) => ({ id: d.id, label: d.title ? `${d.title} · ${t.boardNo(d.boardNo)}` : t.boardNo(d.boardNo) })),
    [t],
  )

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
        // A board imported from a file is kept back for good (§4), so no table deals it from here
        return page.boards.filter((b: BoardSummary) => b.mode !== 'imported').map((b: BoardSummary) => ({ id: b.id, label: t.practiceSetBoard(b.boardNo, formatDate(b.finishedAt, lang)) }))
      }
      if (source === 'mine') return ownItems((await api.ownDeals()).deals)
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
  }, [source, items, t, lang, value, onChange, ownItems])

  const list = items[source]
  const picked = value && value.source !== 'practice' && value.source === source ? value.ids : []
  const pick = (ids: string[]) => onChange(ids.length ? { source: source as 'favorites' | 'featured' | 'mine', ids: ids.slice(0, PRACTICE_SET_BOARDS_MAX) } : undefined)
  const removePicked = async () => {
    const { deals } = await api.removeOwnDeals(picked)
    setItems((before) => ({ ...before, mine: ownItems(deals) }))
    onChange(undefined)
  }

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
            {source === 'mine' && (
              <Button type="button" $size="sm" disabled={!picked.length} onClick={() => void removePicked()}>
                {t.boardImport.removePicked}
              </Button>
            )}
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
      {source === 'mine' && <PbnImport onDeals={(deals) => setItems((before) => ({ ...before, mine: ownItems(deals) }))} />}
      <Muted>{t.practiceSetHint}</Muted>
    </Box>
  )
}

/** Deals from a PBN file or paste for the member's own list (`e10-t09`, AC-10.7) */
function PbnImport({ onDeals }: { onDeals: (deals: OwnDealInfo[]) => void }) {
  const { t, message } = usePreferences()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const parsed = useMemo(() => (text.trim() ? parsePbn(text) : null), [text])
  const count = parsed?.deals.length ?? 0
  const tooMany = count > IMPORT_LIMITS.pbnBoards
  const nothing = !!parsed && !count && !parsed.problems.length

  const submit = async () => {
    if (!parsed || !count || tooMany) return
    setBusy(true)
    setNote(null)
    try {
      let added = 0
      let duplicates = 0
      for (let at = 0; at < count; at += IMPORT_LIMITS.batchDeals) {
        const batch = await api.importOwnDeals(parsed.deals.slice(at, at + IMPORT_LIMITS.batchDeals))
        added += batch.added
        duplicates += batch.duplicates
        onDeals(batch.deals)
      }
      setText('')
      setNote({ error: false, text: t.boardImport.pbnDone(added, duplicates) })
    } catch (error) {
      setNote({ error: true, text: error instanceof ApiError ? message(error.code, error.params, error.message) : t.boardImport.failed })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Import>
      <strong>{t.boardImport.pbnLegend}</strong>
      <Muted>{t.boardImport.pbnHint(IMPORT_LIMITS.pbnBoards, IMPORT_LIMITS.ownDeals)}</Muted>
      <ImportSource value={text} onChange={setText} accept=".pbn,.txt,text/plain" />
      {nothing && <ErrorText role="alert">{message('importNoBoards')}</ErrorText>}
      {tooMany && <ErrorText role="alert">{message('importTooManyBoards', { max: IMPORT_LIMITS.pbnBoards })}</ErrorText>}
      {parsed && <ImportProblems problems={parsed.problems} />}
      {count > 0 && !tooMany && <Muted role="status">{t.boardImport.ready(count)}</Muted>}
      {note && (note.error ? <ErrorText role="alert">{note.text}</ErrorText> : <Muted role="status">{note.text}</Muted>)}
      <div>
        <Button type="button" $size="sm" disabled={!count || tooMany || busy} onClick={() => void submit()}>
          {t.boardImport.pbnSubmit}
        </Button>
      </div>
    </Import>
  )
}
