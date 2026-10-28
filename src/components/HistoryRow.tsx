import styled from 'styled-components'
import type { BoardSummary, PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { formatDateTime, formatRelative, signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { boardPlace, playerName } from '../strings.ts'
import { FavoriteButton } from './FavoriteButton.tsx'
import { ContractLabel } from './Suit.tsx'

/**
 * One board in the history list (DESIGN.md §7.4) and the matching header. A column added here
 * (e.g. a favourite star) goes in `HistoryHead`, `HistoryRow`, `SKELETON` and the widths below; a
 * button in a cell should stop the click from reaching the row, which opens the board.
 *
 * The table never scrolls sideways (e3-t45): it is `table-layout: fixed` and exactly as wide as its
 * frame, every column has a set width (the two pairs share what is left), text that does not fit
 * ends in "…" with the whole of it in `title`, and as the frame narrows the less needed columns
 * fold away (the board, then the date). In a phone-sized frame each board becomes a two-line card,
 * with the date written short (今天 19:50, 10/20 19:50).
 * The widths go by the frame (`HistoryFrame`, a size container), not the window. Every row is the
 * same height, so a page of 20 is as tall as the one before it.
 */

/** Frame widths at which the board column, then the date, fold away, and the rows turn into cards */
const FOLD_BOARD = '900px'
const FOLD_DATE = '700px'
const CARDS = '560px'

/** Holds the table; the table's columns go by its width */
export const HistoryFrame = styled.div`
  container-type: inline-size;
  container-name: history;
`

export const HistoryTable = styled.table`
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 15px;

  th,
  td {
    padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  th {
    background: ${({ theme }) => theme.colors.surfaceAlt};
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.caption.size};
    line-height: ${({ theme }) => theme.type.caption.line};
    font-weight: ${({ theme }) => theme.type.caption.weight};
  }
  tbody tr {
    height: 52px;
  }
  tbody td {
    padding-top: ${({ theme }) => theme.space(2)};
    padding-bottom: ${({ theme }) => theme.space(2)};
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

  [data-col='fav'] {
    width: 48px;
    padding-left: ${({ theme }) => theme.space(2)};
    padding-right: 0;
  }
  [data-col='date'] {
    width: 172px;
  }
  [data-col='board'] {
    width: 132px;
  }
  [data-col='contract'] {
    width: 92px;
  }
  [data-col='result'] {
    width: 76px;
  }
  [data-col='score'] {
    width: 88px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  [data-label],
  [data-short] {
    display: none;
  }

  @container history (max-width: ${FOLD_BOARD}) {
    [data-col='board'] {
      display: none;
    }
    th,
    td {
      padding-left: ${({ theme }) => theme.space(3)};
      padding-right: ${({ theme }) => theme.space(3)};
    }
  }
  @container history (max-width: ${FOLD_DATE}) {
    [data-col='date'] {
      display: none;
    }
  }

  /* A phone: two lines a board, the contract, result, date and score above, the two pairs below */
  @container history (max-width: ${CARDS}) {
    &,
    tbody {
      display: block;
    }
    thead {
      display: none;
    }
    tbody tr {
      display: grid;
      /* The pairs split the second line evenly */
      grid-template-columns: 32px 72px minmax(0, 1fr) minmax(0, 1fr) 56px;
      grid-template-areas:
        'fav contract result date score'
        'fav ns ns ew ew';
      align-items: center;
      column-gap: 6px;
      height: 64px;
      padding: 0 ${({ theme }) => theme.space(3)} 0 ${({ theme }) => theme.space(1)};
      border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    }
    tbody tr:last-child {
      border-bottom: 0;
    }
    tbody td[data-col] {
      display: block;
      width: auto;
      padding: 0;
      border: 0;
    }
    td[data-col='fav'] {
      grid-area: fav;
    }
    td[data-col='contract'] {
      grid-area: contract;
      font-weight: 600;
    }
    td[data-col='result'] {
      grid-area: result;
    }
    td[data-col='score'] {
      grid-area: score;
    }
    tbody td[data-col='board'] {
      display: none;
    }
    /* However long the names, the pairs keep to their half of the line */
    td[data-col='ns'] {
      grid-area: ns;
      contain: inline-size;
    }
    td[data-col='ew'] {
      grid-area: ew;
      contain: inline-size;
    }
    /*
     * The date may also use the result's room (the result is a few characters at its left), so
     * 「Yesterday 22:00」 or 「Hôm qua 22:00」 is not cut short
     */
    td[data-col='date'] {
      grid-column: 3 / 5;
      grid-row: 1;
      text-align: right;
    }
    td[data-col='ns'],
    td[data-col='ew'],
    td[data-col='date'] {
      color: ${({ theme }) => theme.colors.textMuted};
      font-size: ${({ theme }) => theme.type.small.size};
      line-height: ${({ theme }) => theme.type.small.line};
    }
    [data-label] {
      display: inline;
      font-weight: 600;
    }
    [data-long] {
      display: none;
    }
    [data-short] {
      display: inline;
    }
  }
`

const Num = styled.td<{ $value?: number }>`
  font-weight: 600;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

export function HistoryHead() {
  const { t } = usePreferences()
  return (
    <thead>
      <tr>
        <th data-col="fav" aria-label={t.navFavorites} />
        <th data-col="date">{t.date}</th>
        <th data-col="board">{t.board}</th>
        <th data-col="ns">{t.ns}</th>
        <th data-col="ew">{t.ew}</th>
        <th data-col="contract">{t.contract}</th>
        <th data-col="result">{t.result}</th>
        <th data-col="score">{t.scoreNS}</th>
      </tr>
    </thead>
  )
}

export function HistoryRow({ board: b, onOpen }: { board: BoardSummary; onOpen: (id: string) => void }) {
  const { t, lang } = usePreferences()
  const name = (u: PublicUser) => playerName(t, u)
  const date = formatDateTime(b.finishedAt, lang)
  const place = `${boardPlace(t, b)} #${b.boardNo}`
  const ns = `${name(b.players.N)}–${name(b.players.S)}`
  const ew = `${name(b.players.E)}–${name(b.players.W)}`
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
      <td data-col="fav">
        <FavoriteButton boardId={b.id} />
      </td>
      <td data-col="date" title={date}>
        <span data-long>{date}</span>
        <span data-short>{formatRelative(b.finishedAt, lang, { today: t.timeToday, yesterday: t.timeYesterday })}</span>
      </td>
      <td data-col="board" title={place}>
        {place}
      </td>
      <td data-col="ns" title={ns}>
        <span data-label>{t.ns} </span>
        {ns}
      </td>
      <td data-col="ew" title={ew}>
        <span data-label>{t.ew} </span>
        {ew}
      </td>
      <td data-col="contract">
        <ContractLabel contract={b.contract} />
      </td>
      <td data-col="result">{b.contract ? resultLabel(b.contract, b.result.declarerTricks) : '—'}</td>
      <Num data-col="score" $value={b.result.scoreNS}>
        {signed(b.result.scoreNS)}
      </Num>
    </tr>
  )
}

const SkeletonBar = styled.span`
  display: block;
  max-width: 100%;
  height: 14px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

/** Each column of a grey row and how long its bar is */
const SKELETON = [
  ['fav', 20],
  ['date', 120],
  ['board', 70],
  ['ns', '70%'],
  ['ew', '70%'],
  ['contract', 50],
  ['result', 40],
  ['score', 50],
] as const

/** Grey rows the size of the real ones while the list first loads (DESIGN.md §7.6) */
export function HistorySkeleton({ rows }: { rows: number }) {
  return (
    <tbody aria-hidden data-skeleton>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          {SKELETON.map(([col, width]) => (
            <td key={col} data-col={col}>
              <SkeletonBar style={{ width }} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}
