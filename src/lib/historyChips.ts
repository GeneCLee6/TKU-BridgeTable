import { HISTORY_MODES, datePresetOf, type HistoryQuery } from '../../shared/history-query.ts'
import type { PublicUser } from '../../shared/protocol.ts'
import { playerName, type Strings } from '../strings.ts'

/** The history list's filter chips (e4-t22): the conditions in use, each with how to take it off */

type Patch = Partial<HistoryQuery>

/** One condition in use: what it says, and the patch that takes it off */
export interface FilterChip {
  key: string
  text: string
  clear: Patch
}

/**
 * The conditions in a search, one chip each, in the order the filters show them. Level and strain
 * make one contract chip ("4 Spades") and the two dates one date chip; scope, sorting and paging
 * are not conditions.
 */
export function filterChips(query: HistoryQuery, t: Strings, members: PublicUser[], now: number): FilterChip[] {
  const chips: FilterChip[] = []
  const add = (key: string, label: string, value: string, clear: Patch) => chips.push({ key, text: t.filterChip(label, value), clear })
  const member = (id: string) => {
    const user = members.find((u) => u.id === id)
    return user ? playerName(t, user) : id
  }
  if (query.bracket) chips.push({ key: 'bracket', text: t.bracketNames[query.bracket], clear: { bracket: undefined } })
  if (query.level !== undefined || query.strain) {
    const value = [query.level, query.strain && t.suitNames[query.strain]].filter(Boolean).join(' ')
    add('contract', t.contract, value, { level: undefined, strain: undefined })
  }
  if (query.doubled) add('doubled', t.filterDoubled, t.doubledNames[query.doubled], { doubled: undefined })
  if (query.declarer) add('declarer', t.filterDeclarer, member(query.declarer), { declarer: undefined })
  if (query.declarerSeat) add('declarerSeat', t.filterDeclarerSeat, t.seatNames[query.declarerSeat], { declarerSeat: undefined })
  if (query.declarerSide) chips.push({ key: 'declarerSide', text: t.declarerSideNames[query.declarerSide], clear: { declarerSide: undefined } })
  if (query.player)
    add('player', query.scope === 'mine' ? t.filterPlayerMine : t.filterPlayerAll, member(query.player), { player: undefined })
  if (query.partner) add('partner', t.filterPartner, member(query.partner), { partner: undefined })
  if (query.from || query.to) {
    const preset = datePresetOf(query, now)
    const value = preset ? t.datePresetNames[preset] : `${query.from ?? ''} – ${query.to ?? ''}`.trim()
    add('date', t.filterDate, value, { from: undefined, to: undefined })
  }
  if (query.result) add('result', t.filterResult, t.resultFilterNames[query.result], { result: undefined })
  if (query.vul) chips.push({ key: 'vul', text: t.vulNames[query.vul], clear: { vul: undefined } })
  if (query.boardNo !== undefined) add('boardNo', t.filterBoardNo, String(query.boardNo), { boardNo: undefined })
  if (query.table !== undefined) add('table', t.filterTable, String(query.table), { table: undefined })
  if (query.mode) {
    const known = HISTORY_MODES.find((m) => m === query.mode)
    add('mode', t.filterMode, known ? t.modeNames[known] : query.mode, { mode: undefined })
  }
  return chips
}

/** A patch taking off every condition, keeping scope, sorting and page size */
export const clearAllFilters = (chips: FilterChip[]): Patch => Object.assign({}, ...chips.map((chip) => chip.clear))
