import { X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import styled from 'styled-components'
import { STRAINS } from '../../shared/auction.ts'
import { SEATS } from '../../shared/cards.ts'
import {
  CONTRACT_BRACKETS,
  DATE_PRESETS,
  DECLARER_SIDES,
  DOUBLED_FILTERS,
  HISTORY_MODES,
  RESULT_FILTERS,
  VULNERABILITIES,
  datePresetOf,
  datePresetRange,
  type DatePreset,
  type HistoryQuery,
} from '../../shared/history-query.ts'
import type { PublicUser } from '../../shared/protocol.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { clearAllFilters, type FilterChip } from '../lib/historyChips.ts'
import { playerName } from '../strings.ts'
import { Chip, ChipStrip } from './Chips.tsx'
import { Button } from './ui.tsx'

/**
 * The history list's filters (e4-t16…t20) and the chips naming the ones in use (e4-t22): contract, declarer, players, dates, and result,
 * vulnerability, board, table and mode. Every change goes straight to `onChange`, which writes it
 * into the address; a field left on "any" is left out of the search.
 */

const Fields = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px 12px;
`

const Group = styled.fieldset`
  margin: 0 0 14px;
  padding: 0;
  border: 0;
  min-width: 0;

  & > legend {
    margin-bottom: 8px;
    padding: 0;
    font-weight: 700;
  }
`

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  font-weight: 600;

  & > select,
  & > input {
    min-height: 34px;
    padding: 0 6px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.surface};
    color: ${({ theme }) => theme.colors.text};
    font-size: 14px;
    font-weight: 400;
  }
`

/** The contract brackets: one row of chips, as everywhere (`Chips.tsx`) */
const Quick = styled(ChipStrip)`
  margin-bottom: 10px;
`

type Patch = Partial<HistoryQuery>

interface SelectProps<T extends string | number> {
  label: string
  value: T | undefined
  options: readonly (readonly [T, string])[]
  onChange: (value: T | undefined) => void
}

/** A drop-down whose first choice is "any" */
function Select<T extends string | number>({ label, value, options, onChange }: SelectProps<T>) {
  const { t } = usePreferences()
  return (
    <Field>
      {label}
      <select
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(options.find(([v]) => String(v) === e.target.value)?.[0])}
      >
        <option value="">{t.filterAny}</option>
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  )
}

/** A whole number from 1 to 9999, or nothing */
function NumberField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (value: number | undefined) => void }) {
  return (
    <Field>
      {label}
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={9999}
        value={value ?? ''}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(Number.isInteger(n) && n >= 1 && n <= 9999 ? n : undefined)
        }}
      />
    </Field>
  )
}

function Section({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <Group>
      <legend>{legend}</legend>
      {children}
    </Group>
  )
}

interface Props {
  query: HistoryQuery
  /** Members to choose from; someone named in the address but not here is still offered */
  members: PublicUser[]
  onChange: (patch: Patch) => void
  now?: number
}

export function HistoryFilters({ query, members, onChange, now: nowProp }: Props) {
  const { t } = usePreferences()
  // "Today" is the day the filters opened; a page left open past midnight keeps that day
  const [openedAt] = useState(Date.now)
  const now = nowProp ?? openedAt
  const [customDates, setCustomDates] = useState(false)
  const preset = datePresetOf(query, now)
  const showDates = customDates || (!preset && Boolean(query.from || query.to))
  const dateChoice: DatePreset | 'custom' | '' = showDates ? 'custom' : (preset ?? '')

  const memberOptions = (selected: string | undefined) => {
    const options = members.map((u) => [u.id, playerName(t, u)] as const)
    return selected && !members.some((u) => u.id === selected) ? [...options, [selected, selected] as const] : options
  }

  return (
    <div>
      <Section legend={t.contract}>
        <Quick role="group" aria-label={t.contract}>
          {CONTRACT_BRACKETS.map((bracket) => (
            <Chip
              key={bracket}
              type="button"
              $active={query.bracket === bracket}
              aria-pressed={query.bracket === bracket}
              onClick={() => onChange({ bracket: query.bracket === bracket ? undefined : bracket })}
            >
              {t.bracketNames[bracket]}
            </Chip>
          ))}
        </Quick>
        <Fields>
          <Select
            label={t.filterLevel}
            value={query.level}
            options={[1, 2, 3, 4, 5, 6, 7].map((n) => [n, String(n)] as const)}
            onChange={(level) => onChange({ level })}
          />
          <Select
            label={t.filterStrain}
            value={query.strain}
            options={STRAINS.map((s) => [s, t.suitNames[s]] as const)}
            onChange={(strain) => onChange({ strain })}
          />
          <Select
            label={t.filterDoubled}
            value={query.doubled}
            options={DOUBLED_FILTERS.map((d) => [d, t.doubledNames[d]] as const)}
            onChange={(doubled) => onChange({ doubled })}
          />
        </Fields>
      </Section>

      <Section legend={t.filterDeclarer}>
        <Fields>
          <Select
            label={t.filterDeclarer}
            value={query.declarer}
            options={memberOptions(query.declarer)}
            onChange={(declarer) => onChange({ declarer })}
          />
          <Select
            label={t.filterDeclarerSeat}
            value={query.declarerSeat}
            options={SEATS.map((s) => [s, t.seatNames[s]] as const)}
            onChange={(declarerSeat) => onChange({ declarerSeat })}
          />
          <Select
            label={t.filterDeclarerSide}
            value={query.declarerSide}
            options={DECLARER_SIDES.map((s) => [s, t.declarerSideNames[s]] as const)}
            onChange={(declarerSide) => onChange({ declarerSide })}
          />
        </Fields>
      </Section>

      <Section legend={t.players}>
        <Fields>
          <Select
            label={query.scope === 'mine' ? t.filterPlayerMine : t.filterPlayerAll}
            value={query.player}
            options={memberOptions(query.player)}
            onChange={(player) => onChange({ player })}
          />
          <Select
            label={t.filterPartner}
            value={query.partner}
            options={memberOptions(query.partner)}
            onChange={(partner) => onChange({ partner })}
          />
        </Fields>
      </Section>

      <Section legend={t.filterDate}>
        <Fields>
          <Select
            label={t.filterDate}
            value={dateChoice || undefined}
            options={[...DATE_PRESETS.map((p) => [p, t.datePresetNames[p]] as const), ['custom', t.dateCustom] as const]}
            onChange={(choice) => {
              setCustomDates(choice === 'custom')
              if (choice === 'custom') return
              onChange(choice ? datePresetRange(choice, now) : { from: undefined, to: undefined })
            }}
          />
          {showDates && (
            <>
              <Field>
                {t.dateFrom}
                <input type="date" value={query.from ?? ''} max={query.to} onChange={(e) => onChange({ from: e.target.value || undefined })} />
              </Field>
              <Field>
                {t.dateTo}
                <input type="date" value={query.to ?? ''} min={query.from} onChange={(e) => onChange({ to: e.target.value || undefined })} />
              </Field>
            </>
          )}
        </Fields>
      </Section>

      <Section legend={t.filters}>
        <Fields>
          <Select
            label={t.filterResult}
            value={query.result}
            options={RESULT_FILTERS.map((r) => [r, t.resultFilterNames[r]] as const)}
            onChange={(result) => onChange({ result })}
          />
          <Select
            label={t.filterVul}
            value={query.vul}
            options={VULNERABILITIES.map((v) => [v, t.vulNames[v]] as const)}
            onChange={(vul) => onChange({ vul })}
          />
          <NumberField label={t.filterBoardNo} value={query.boardNo} onChange={(boardNo) => onChange({ boardNo })} />
          <NumberField label={t.filterTable} value={query.table} onChange={(table) => onChange({ table })} />
          <Select
            label={t.filterMode}
            value={HISTORY_MODES.find((m) => m === query.mode)}
            options={HISTORY_MODES.map((m) => [m, t.modeNames[m]] as const)}
            onChange={(mode) => onChange({ mode })}
          />
        </Fields>
      </Section>
    </div>
  )
}

// ── Chips (e4-t22) ───────────────────────────────────────────────────────────────────────────────

const ChipRow = styled.ul`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 16px;
  padding: 0;
  list-style: none;
`

const Tag = styled.li`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 30px;
  max-width: 100%;
  padding: 0 4px 0 12px;
  border: 1px solid ${({ theme }) => theme.colors.primary};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 600;

  & > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const Remove = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.text};
  }
`

/** The conditions in use as chips, each with its own remove button, and "clear all" */
export function FilterChips({ chips, onChange }: { chips: FilterChip[]; onChange: (patch: Patch) => void }) {
  const { t } = usePreferences()
  if (chips.length === 0) return null
  return (
    <ChipRow aria-label={t.activeFilters}>
      {chips.map((chip) => (
        <Tag key={chip.key}>
          <span>{chip.text}</span>
          <Remove type="button" aria-label={t.removeFilter(chip.text)} title={t.removeFilter(chip.text)} onClick={() => onChange(chip.clear)}>
            <X size={14} aria-hidden />
          </Remove>
        </Tag>
      ))}
      <li>
        <Button type="button" $variant="ghost" $small onClick={() => onChange(clearAllFilters(chips))}>
          {t.clearFilters}
        </Button>
      </li>
    </ChipRow>
  )
}
