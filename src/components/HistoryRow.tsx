import styled from 'styled-components'
import type { BoardSummary, PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'
import { ContractLabel } from './Suit.tsx'

/**
 * One board in the history list (DESIGN.md §7.4) and the matching header. A column added here
 * (e.g. a favourite star) goes in both `HistoryHead` and `HistoryRow`; a button in a cell should
 * stop the click from reaching the row, which opens the board.
 */

export const HistoryTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;
  white-space: nowrap;

  th,
  td {
    padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.caption.size};
    line-height: ${({ theme }) => theme.type.caption.line};
    font-weight: ${({ theme }) => theme.type.caption.weight};
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  tbody tr[data-href] {
    cursor: pointer;
    &:hover {
      background: ${({ theme }) => theme.colors.surfaceAlt};
    }
    &:focus-visible {
      outline: 2px solid ${({ theme }) => theme.colors.focus};
      outline-offset: -2px;
    }
  }
`

const Num = styled.td<{ $value?: number }>`
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

const NumHead = styled.th`
  text-align: right !important;
`

export function HistoryHead() {
  const { t } = usePreferences()
  return (
    <thead>
      <tr>
        <th>{t.date}</th>
        <th>{t.board}</th>
        <th>{t.ns}</th>
        <th>{t.ew}</th>
        <th>{t.contract}</th>
        <th>{t.result}</th>
        <NumHead>{t.scoreNS}</NumHead>
      </tr>
    </thead>
  )
}

export function HistoryRow({ board: b, onOpen }: { board: BoardSummary; onOpen: (id: string) => void }) {
  const { t, lang } = usePreferences()
  const name = (u: PublicUser) => playerName(t, u)
  return (
    <tr
      data-href
      tabIndex={0}
      onClick={() => onOpen(b.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen(b.id)
        }
      }}
    >
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
  )
}

const SkeletonBar = styled.span`
  display: block;
  height: 14px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

/** Grey rows the size of the real ones while the list loads (DESIGN.md §7.6) */
export function HistorySkeleton({ rows }: { rows: number }) {
  return (
    <tbody aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          {[120, 70, 110, 110, 50, 40, 50].map((width, j) => (
            <td key={j}>
              <SkeletonBar style={{ width }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}
