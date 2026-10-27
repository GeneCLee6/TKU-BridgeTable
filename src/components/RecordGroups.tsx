import { useEffect, useState, type ReactNode } from 'react'
import styled, { css } from 'styled-components'
import {
  HISTORY_MODES,
  historyQueryString,
  readHistoryQuery,
  type HistoryMode,
  type HistoryQuery,
} from '../../shared/history-query.ts'
import type { HistoryDay } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDay } from '../lib/format.ts'
import { groupQuery, RECORD_GROUPINGS, type RecordGrouping } from '../lib/lists.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ActionButton } from './ui.tsx'

/**
 * How records are grouped, the same on 牌局紀錄 and in the side panel's 紀錄 (社長 2026-10-27): by
 * date first (the default, U3a `e3-t48`), each date with how many boards were played that day; or by
 * topic first — 一般牌桌, 挑戰, 隊制賽, 練習 (`BoardSummary.mode`) — then the dates inside it; or
 * not grouped, one list. Every level is a search the server answers with the filters in use
 * (`mode` for the topic, `from`–`to` for the date), so the counts and the boards always agree.
 * `RecordGroups` shows the topics or the dates until one is picked, with the way back above, and
 * then hands the search for that group's boards to its child, which lists them as its page does.
 */

const Switch = styled.div`
  display: inline-flex;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  overflow: hidden;
`

const SwitchButton = styled.button<{ $active: boolean }>`
  min-height: 32px;
  padding: 0 12px;
  border: 0;
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: 600;
  ${({ $active, theme }) =>
    $active &&
    css`
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
`

/** 「依日期｜依主題｜不分組」 */
export function GroupingSwitch({
  value,
  onChange,
}: {
  value: RecordGrouping
  onChange: (next: RecordGrouping) => void
}) {
  const { t } = usePreferences()
  return (
    <Switch role="group" aria-label={t.groupBy}>
      {RECORD_GROUPINGS.map((g) => (
        <SwitchButton
          key={g}
          type="button"
          $active={value === g}
          aria-pressed={value === g}
          onClick={() => onChange(g)}
        >
          {t.groupings[g]}
        </SwitchButton>
      ))}
    </Switch>
  )
}

const GroupRow = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 14px;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  background: none;
  color: ${({ theme }) => theme.colors.text};
  text-align: left;
  font-size: 15px;
  font-weight: 600;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: -2px;
  }
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
`

/** Above a group's contents: the way back up, and which group this is */
const PathBar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};

  & > strong {
    padding-right: 6px;
    font-size: 14px;
  }
`

const Empty = styled.p`
  margin: 0;
  padding: 14px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

/** The topics a search can have: the one its filter asks for, else all four */
const topicsFor = (query: HistoryQuery): HistoryMode[] => {
  const only = HISTORY_MODES.find((m) => m === query.mode)
  return only ? [only] : [...HISTORY_MODES]
}

/** How many boards each topic has for a search (the total of a small page each); `key` stands for the search */
function useTopicCounts(query: HistoryQuery, enabled: boolean, reload: unknown) {
  const key = historyQueryString({ ...query, page: 1 })
  const [loaded, setLoaded] = useState<{
    key: string
    counts: { topic: HistoryMode; count: number }[]
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const asked = readHistoryQuery(new URLSearchParams(key))
    const base = { ...asked, page: 1, size: 10 }
    Promise.all(
      topicsFor(asked).map((topic) =>
        api
          .searchHistory({ ...base, mode: topic })
          .then((page) => ({ topic, count: page.total }))
          .catch(() => ({ topic, count: 0 })),
      ),
    ).then((counts) => !cancelled && setLoaded({ key, counts }))
    return () => {
      cancelled = true
    }
  }, [key, enabled, reload])
  return loaded?.key === key ? loaded.counts : null
}

/** How many boards each Taiwan date has for a search, newest first */
function useDays(query: HistoryQuery, enabled: boolean, reload: unknown) {
  const key = historyQueryString({ ...query, page: 1 })
  const [loaded, setLoaded] = useState<{ key: string; days: HistoryDay[] } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    api
      .historyDays(readHistoryQuery(new URLSearchParams(key)))
      .then((answer) => !cancelled && setLoaded({ key, days: answer.days ?? [] }))
      .catch(() => !cancelled && setLoaded({ key, days: [] }))
    return () => {
      cancelled = true
    }
  }, [key, enabled, reload])
  return loaded?.key === key ? loaded.days : null
}

export function RecordGroups({
  query,
  grouping,
  topic,
  day,
  onTopic,
  onDay,
  empty,
  reload,
  children,
}: {
  /** The search, with its filters, before any group is picked */
  query: HistoryQuery
  grouping: RecordGrouping
  topic: HistoryMode | null
  day: string | null
  onTopic: (topic: HistoryMode | null) => void
  onDay: (day: string | null) => void
  /** Shown when there is nothing to group (the caller's own empty state) */
  empty: ReactNode
  /** Anything that changes when the counts should be asked again (a board finished) */
  reload?: unknown
  /** The boards of the group picked (or of every board, not grouped) */
  children: (query: HistoryQuery) => ReactNode
}) {
  const { t, lang } = usePreferences()
  const inTopic = grouping === 'topic' ? topic : null
  const needTopic = grouping === 'topic' && !inTopic
  const needDay = grouping !== 'none' && !needTopic && !day
  const topics = useTopicCounts(query, needTopic, reload)
  const days = useDays(groupQuery(query, inTopic, null), needDay, reload)
  const dayName = (date: string) =>
    formatDay(date, lang, { today: t.timeToday, yesterday: t.timeYesterday })

  if (grouping === 'none') return <>{children(query)}</>

  if (needTopic) {
    const shown = topics?.filter((x) => x.count > 0)
    return !shown ? (
      <Empty>{t.loading}</Empty>
    ) : shown.length === 0 ? (
      empty
    ) : (
      <div role="list" aria-label={t.historyByTopic}>
        {shown.map((x) => (
          <div role="listitem" key={x.topic}>
            <GroupRow type="button" onClick={() => onTopic(x.topic)}>
              <span>{t.modeNames[x.topic]}</span>
              <small>{t.dayBoards(x.count)}</small>
            </GroupRow>
          </div>
        ))}
      </div>
    )
  }

  const topicBar = inTopic && (
    <PathBar>
      <ActionButton back onClick={() => onTopic(null)}>
        {t.backToTopics}
      </ActionButton>
      <strong>{t.modeNames[inTopic]}</strong>
    </PathBar>
  )

  if (needDay)
    return (
      <>
        {topicBar}
        {!days ? (
          <Empty>{t.loading}</Empty>
        ) : days.length === 0 ? (
          empty
        ) : (
          <div role="list" aria-label={t.historyByDay}>
            {days.map((d) => (
              <div role="listitem" key={d.date}>
                <GroupRow type="button" onClick={() => onDay(d.date)}>
                  <span>{dayName(d.date)}</span>
                  <small>{t.dayBoards(d.count)}</small>
                </GroupRow>
              </div>
            ))}
          </div>
        )}
      </>
    )

  return (
    <>
      <PathBar>
        <ActionButton back onClick={() => onDay(null)}>
          {t.backToDays}
        </ActionButton>
        <strong>{inTopic ? `${t.modeNames[inTopic]} · ${dayName(day!)}` : dayName(day!)}</strong>
      </PathBar>
      {children(groupQuery(query, inTopic, day))}
    </>
  )
}
