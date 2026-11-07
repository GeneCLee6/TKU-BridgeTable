import { useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import type { ProductMetricsView } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useToast } from './Toast.tsx'
import { ErrorText, Muted } from './ui.tsx'

/**
 * The admin page's usage numbers (e12-t17, ARCHITECTURE.md §5.27). The server has already hidden
 * what is too small to show (null here), so a number the page does not have cannot be worked out
 * from it. The switch is the one on BridgeHall's admin page too, and says so
 */

const shortDay = (day: string) => day.slice(5)

function Bars({ title, items, min }: { title: string; items: { key: string; value: number | null }[]; min: number }) {
  const { t } = usePreferences()
  const m = t.productMetrics
  const largest = Math.max(1, ...items.map((i) => i.value ?? 0))
  const latest = items.at(-1)?.value ?? null
  return (
    <div>
      <ChartHead>
        <h3>{title}</h3>
        <Muted>{latest === null ? m.hidden(min) : m.latest(latest)}</Muted>
      </ChartHead>
      <Plot>
        {items.map((item, i) => {
          const under = i === items.length - 1
          const text = `${item.key}: ${item.value ?? m.hidden(min)}${under ? ` (${m.underWay})` : ''}`
          return (
            <Column key={item.key} title={text} aria-label={text}>
              <Bar $height={item.value === null ? 0 : (item.value / largest) * 100} $hidden={item.value === null} $under={under} />
            </Column>
          )
        })}
      </Plot>
      <Axis aria-hidden="true">
        <span>{shortDay(items[0].key)}</span>
        <span>{shortDay(items[items.length - 1].key)}</span>
      </Axis>
    </div>
  )
}

function Retention({ view }: { view: ProductMetricsView }) {
  const { t } = usePreferences()
  const m = t.productMetrics
  const { weeks, rows } = view.retention
  if (!rows.length) return <Muted>{m.retentionEmpty}</Muted>
  return (
    <Scroll>
      <Table>
        <thead>
          <tr>
            <th scope="col">{m.cohort}</th>
            <th scope="col">{m.cohortSize}</th>
            {weeks.map((week) => (
              <th key={week} scope="col">
                {shortDay(week)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.cohort ?? 'earlier'}>
              <th scope="row">{row.cohort === null ? m.earlier : shortDay(row.cohort)}</th>
              <td>{row.size ?? m.hidden(view.minCount)}</td>
              {weeks.map((week) => {
                const cell = row.cells.find((c) => c.week === week)
                if (!cell) return <td key={week} />
                if (cell.active === null || row.size === null)
                  return (
                    <td key={week} title={m.hiddenCell} aria-label={m.hiddenCell}>
                      –
                    </td>
                  )
                return (
                  <td key={week} title={`${cell.active} / ${row.size}`}>
                    {Math.round((cell.active / row.size) * 100)}%
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Table>
    </Scroll>
  )
}

export function ProductMetrics() {
  const { t, message } = usePreferences()
  const m = t.productMetrics
  const toast = useToast()
  const id = useId()
  const [view, setView] = useState<ProductMetricsView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const failed = (e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)

  // `failed` only sets state, once the answer is in
  useEffect(() => {
    api.admin.productMetrics().then(setView).catch(failed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      setView(await api.admin.setProductMetrics(enabled))
      toast.success(m.saved)
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  if (!view) return error ? <ErrorText role="alert">{error}</ErrorText> : <Muted role="status">{t.loading}</Muted>

  const min = view.minCount
  const anything = view.days.some((d) => d.active !== null) || view.weeks.some((w) => w.active !== null)
  return (
    <Body>
      <div>
        <Switch htmlFor={`${id}-on`}>
          <input id={`${id}-on`} type="checkbox" checked={view.enabled} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
          {m.switchLabel}
        </Switch>
        <Muted>{m.switchHint}</Muted>
      </div>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!view.enabled && <Muted role="status">{m.off}</Muted>}
      {view.since && <Muted>{m.since(view.since)}</Muted>}
      {!anything ? (
        <Muted>{m.empty(min)}</Muted>
      ) : (
        <>
          <Muted>{m.notes(min)}</Muted>
          <Bars title={m.dauTitle} min={min} items={view.days.map((d) => ({ key: d.day, value: d.active }))} />
          <Bars title={m.wauTitle} min={min} items={view.weeks.map((w) => ({ key: w.week, value: w.active }))} />
          <div>
            <h3>{m.retentionTitle}</h3>
            <Muted>{m.retentionHint(min)}</Muted>
            <Retention view={view} />
          </div>
          <div>
            <h3>{m.boardsTitle}</h3>
            {view.boardsPerTable === null ? <Muted>{m.boardsHidden(min)}</Muted> : <Figure>{m.boardsValue(view.boardsPerTable)}</Figure>}
          </div>
          <div>
            <h3>{m.featuresTitle}</h3>
            <Features>
              {view.features.map((f) => (
                <li key={f.key}>
                  <span>{m.features[f.key]}</span>
                  <span>{f.count ?? m.hidden(min)}</span>
                </li>
              ))}
            </Features>
          </div>
        </>
      )}
    </Body>
  )
}

const Body = styled.div`
  display: grid;
  /* minmax(0, …) so the retention table scrolls by itself instead of widening the page */
  grid-template-columns: minmax(0, 1fr);
  gap: ${({ theme }) => theme.space(6)};

  & h3 {
    margin: 0 0 ${({ theme }) => theme.space(2)};
    color: ${({ theme }) => theme.colors.text};
    font-size: inherit;
    font-weight: 600;
  }
`

const Switch = styled.label`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`

const ChartHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(2)};
`

const Plot = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 96px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`

const Column = styled.div`
  display: flex;
  flex: 1 1 0;
  align-items: flex-end;
  height: 100%;
  min-width: 0;
`

const Bar = styled.div<{ $height: number; $hidden: boolean; $under: boolean }>`
  width: 100%;
  height: ${({ $hidden, $height }) => ($hidden ? '4px' : `${Math.max($height, 4)}%`)};
  border-radius: 4px 4px 0 0;
  background: ${({ theme, $hidden, $under }) => ($hidden ? theme.colors.borderStrong : $under ? theme.colors.primarySoft : theme.colors.primary)};
  box-shadow: ${({ theme, $hidden, $under }) => (!$hidden && $under ? `inset 0 0 0 1px ${theme.colors.primary}` : 'none')};
`

const Axis = styled.div`
  display: flex;
  justify-content: space-between;
  margin-top: ${({ theme }) => theme.space(1)};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.small.size};
`

const Scroll = styled.div`
  margin-top: ${({ theme }) => theme.space(2)};
  overflow-x: auto;
`

const Table = styled.table`
  border-collapse: collapse;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.small.size};
  font-variant-numeric: tabular-nums;
  white-space: nowrap;

  & th,
  & td {
    padding: ${({ theme }) => `${theme.space(1)} ${theme.space(2)}`};
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: right;
    font-weight: 400;
  }
  & thead th {
    color: ${({ theme }) => theme.colors.textMuted};
  }
  & tr > th:first-child {
    text-align: left;
  }
`

const Figure = styled.div`
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.h2.size};
  font-variant-numeric: tabular-nums;
`

const Features = styled.ul`
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;

  & li {
    display: flex;
    justify-content: space-between;
    gap: ${({ theme }) => theme.space(3)};
    padding: ${({ theme }) => `${theme.space(1)} 0`};
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    color: ${({ theme }) => theme.colors.text};
    font-variant-numeric: tabular-nums;
  }
`
