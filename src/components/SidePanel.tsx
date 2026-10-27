import { ArrowLeft, BookOpen, History, Mail, MessageSquare, Users, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import styled, { css, keyframes } from 'styled-components'
import {
  DEFAULT_HISTORY_QUERY,
  historyQueryString,
  taiwanDate,
  type HistoryMode,
  type HistoryQuery,
} from '../../shared/history-query.ts'
import type { BoardRecord, BoardSummary, HistoryDay, PublicUser } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDay, signed } from '../lib/format.ts'
import { isGrouping, type RecordGrouping } from '../lib/lists.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useScrollLock } from '../lib/useScrollLock.ts'
import { dockHeight, mobile, mobileQuery, tablet } from '../styles/tokens.ts'
import { boardPlace, playerName } from '../strings.ts'
import { BoardRecordView } from './BoardRecordView.tsx'
import { DirectMessages } from './DirectMessages.tsx'
import { PeopleList } from './PeopleList.tsx'
import { GroupingSwitch, RecordGroups } from './RecordGroups.tsx'
import { ActionButton, ActionLink, Button } from './ui.tsx'
import { ContractResult } from './Suit.tsx'

/**
 * BBO's right-hand dock: a narrow strip of tabs on the far right (chat, people, messages, history). Clicking
 * a tab opens its panel beside the strip; clicking it again closes the panel, so the table gets
 * the space back. History opens a board right in the panel, so you can keep playing on the left
 * and look at an earlier board on the right. The open tab is remembered per page. There is no ✕ on
 * the panel (e3-t47): the strip is always beside it, and Esc inside the panel closes it too,
 * handing the focus back to its tab.
 *
 * On a phone (社長 2026-10-27) the strip is a tab bar fixed to the foot of the screen, above the
 * iPhone's home bar, and a tab opens its panel as a sheet sliding up from the bar, over a dimmed
 * page that stays still (`useScrollLock`). The sheet closes from its tab, its ✕, a tap on the
 * dimmed page, Esc, or a pull down on its head. At a table the bar is lower (`compact`) so the
 * hand keeps its room. A phone always starts with the sheet closed.
 */

export type PanelTab = 'chat' | 'people' | 'messages' | 'history' | 'conventions'

/** A pull down on the sheet's head longer than this closes it */
const PULL_TO_CLOSE = 80

const Dock = styled.div`
  position: relative;
  display: flex;
  min-height: 0;
  height: 100%;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};

  ${mobile} {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 25;
    display: block;
    height: auto;
    border-left: 0;
  }
`

const Rail = styled.nav<{ $compact: boolean }>`
  display: flex;
  flex-direction: column;
  flex: none;
  width: 68px;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};

  ${mobile} {
    position: relative;
    z-index: 2;
    flex-direction: row;
    width: 100%;
    height: ${({ $compact }) => dockHeight($compact)};
    padding: 0 env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
    border-left: 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
`

const RailButton = styled.button<{ $active: boolean; $compact: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  position: relative;
  min-height: 68px;
  padding: 6px 2px;
  border: 0;
  border-left: 3px solid transparent;
  background: none;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  font-weight: 700;

  &:hover {
    background: ${({ theme }) => theme.colors.surface};
  }
  ${({ $active, theme }) =>
    $active &&
    css`
      border-left-color: ${theme.colors.primary};
      background: ${theme.colors.surface};
      color: ${theme.colors.primary};
    `}

  ${mobile} {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 2px;
    border-left: 0;
    border-top: 3px solid
      ${({ $active, theme }) => ($active ? theme.colors.primary : 'transparent')};
    white-space: nowrap;

    ${({ $compact }) =>
      $compact &&
      css`
        gap: 1px;
        font-size: 11px;
        line-height: 14px;

        & > svg {
          width: 18px;
          height: 18px;
        }
      `}
  }
`

const RailBadge = styled.span<{ $compact: boolean }>`
  position: absolute;
  top: 6px;
  right: 10px;
  min-width: 18px;
  padding: 0 5px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.danger};
  color: ${({ theme }) => theme.colors.onPrimary};
  font-size: 11px;
  line-height: 18px;

  ${mobile} {
    top: ${({ $compact }) => ($compact ? '2px' : '4px')};
    right: calc(50% - 26px);
  }
`

const rise = keyframes`
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
`

/** One width for every tab, the one a board needs, so switching tabs never moves the page (社長 2026-10-27) */
const Content = styled.section<{ $compact: boolean }>`
  display: flex;
  flex-direction: column;
  width: ${({ theme }) => theme.layout.dockPanelWidth};
  min-height: 0;

  /* On a tablet the open panel floats over the page instead of narrowing it (e3-t36) */
  ${tablet} {
    position: absolute;
    top: 0;
    right: 100%;
    bottom: 0;
    z-index: 15;
    border-left: 1px solid ${({ theme }) => theme.colors.border};
    background: ${({ theme }) => theme.colors.surface};
    box-shadow: ${({ theme }) => theme.shadowRaised};
  }

  /* On a phone, a sheet rising from the tab bar; one height for every tab, as on a computer */
  ${mobile} {
    position: fixed;
    right: 0;
    bottom: ${({ $compact }) => dockHeight($compact)};
    left: 0;
    z-index: 1;
    width: auto;
    height: 78vh;
    height: min(78dvh, calc(100dvh - ${({ theme }) => theme.layout.headerHeight} - ${({ $compact }) => dockHeight($compact)} - 8px));
    padding: 0 env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    border-top: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.lg} ${({ theme }) => theme.radius.lg} 0 0;
    background: ${({ theme }) => theme.colors.surface};
    box-shadow: ${({ theme }) => theme.shadowRaised};
    animation: ${rise} 0.2s ease-out;
    transition: transform 0.15s ease-out;
  }
`

/** The dimmed page behind the phone's sheet; a tap on it closes the sheet */
const Scrim = styled.div`
  position: fixed;
  inset: 0;
  background: ${({ theme }) => theme.colors.overlay};
  overscroll-behavior: contain;
  touch-action: none;
`

const ContentHead = styled.div`
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 800;
  color: ${({ theme }) => theme.colors.primaryStrong};

  ${mobile} {
    padding: 12px 6px 0 16px;
    touch-action: none;
    user-select: none;
  }
`

/** The pull tab at the top of the phone's sheet */
const Grip = styled.span`
  position: absolute;
  top: 6px;
  left: 50%;
  width: 40px;
  height: 4px;
  margin-left: -20px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.border};
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
`

const STORAGE_KEY = 'tku-bridge-table:dock'

function readOpen(page: string, fallback: PanelTab | null): PanelTab | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    return page in stored ? stored[page] : fallback
  } catch {
    return fallback
  }
}

function writeOpen(page: string, tab: PanelTab | null) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, [page]: tab }))
  } catch {
    // Storage blocked: the dock just opens with its default
  }
}

export function SidePanel({
  tabs,
  page,
  initial = null,
  chat,
  conventions,
  recent,
}: {
  tabs: PanelTab[]
  /** Remembers which tab is open separately for each page ('table', 'lobby') */
  page: string
  initial?: PanelTab | null
  chat?: ReactNode
  /** The 特約 tab at a table (`e10-t06`): the book's pages for the auction on it */
  conventions?: ReactNode
  /** Boards finished at the current table; enables the "this table" history view */
  recent?: BoardSummary[]
}) {
  const { t } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  // A phone starts with the sheet closed, so the page is what you see first
  const [open, setOpen] = useState<PanelTab | null>(() => {
    if (phone) return null
    const stored = readOpen(page, initial)
    return stored && tabs.includes(stored) ? stored : null
  })
  // A window narrowed to a phone's width closes the panel rather than covering the page with it
  const [wasPhone, setWasPhone] = useState(phone)
  if (phone !== wasPhone) {
    setWasPhone(phone)
    if (phone) setOpen(null)
  }
  const sheet = phone && open !== null
  useScrollLock(sheet)
  /** How far the sheet's head has been pulled down */
  const [pull, setPull] = useState(0)
  const pullFrom = useRef<number | null>(null)
  // At a table the phone's bar is lower, so the hand keeps its room
  const compact = page === 'table'
  const [board, setBoard] = useState<string | null>(null)
  const [talkTo, setTalkTo] = useState<string | null>(null)
  const { directs } = useClub()
  const icon = {
    chat: MessageSquare,
    people: Users,
    messages: Mail,
    history: History,
    conventions: BookOpen,
  }
  const label = {
    chat: t.tabChat,
    people: t.tabPeople,
    messages: t.tabMessages,
    history: t.tabHistory,
    conventions: t.tabConventions,
  }
  const unread = { messages: directs?.unread ?? 0 } as Partial<Record<PanelTab, number>>

  // A phone does not remember the open tab: it would open the sheet over the page next time
  const show = (tab: PanelTab | null) => {
    setOpen(tab)
    setPull(0)
    if (!phone) writeOpen(page, tab)
  }
  const toggle = (tab: PanelTab) => show(open === tab ? null : tab)
  const rail = useRef<HTMLElement>(null)

  /** Esc inside the open panel closes it, unless something in it (a menu, a dialog) used the key */
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !open) return
    e.preventDefault()
    rail.current?.querySelector<HTMLElement>(`[data-tab="${open}"]`)?.focus()
    toggle(open)
  }

  /** The People tab's envelope: opens that conversation in the Messages tab */
  const message = (userId: string) => {
    setTalkTo(userId)
    show('messages')
  }

  return (
    <Dock aria-label={t.sidePanel} data-tour="side">
      {sheet && <Scrim data-testid="dock-scrim" onClick={() => show(null)} />}
      {open && (
        <Content
          role="tabpanel"
          aria-label={label[open]}
          onKeyDown={closeOnEscape}
          $compact={compact}
          style={pull ? { transform: `translateY(${pull}px)`, transition: 'none' } : undefined}
        >
          <ContentHead
            {...(phone && {
              onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
                if ((e.target as HTMLElement).closest('button')) return
                pullFrom.current = e.clientY
                e.currentTarget.setPointerCapture(e.pointerId)
              },
              onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
                if (pullFrom.current !== null) setPull(Math.max(0, e.clientY - pullFrom.current))
              },
              onPointerUp: () => {
                if (pullFrom.current === null) return
                pullFrom.current = null
                if (pull > PULL_TO_CLOSE) show(null)
                else setPull(0)
              },
              onPointerCancel: () => {
                pullFrom.current = null
                setPull(0)
              },
            })}
          >
            {phone && <Grip aria-hidden />}
            <span>{label[open]}</span>
            {phone && (
              <Button type="button" $variant="ghost" $size="sm" aria-label={t.close} title={t.close} onClick={() => show(null)}>
                <X size={20} aria-hidden />
              </Button>
            )}
          </ContentHead>
          <Body>
            {open === 'chat' && chat}
            {open === 'conventions' && conventions}
            {open === 'people' && (
              <People
                onMessage={tabs.includes('messages') ? message : undefined}
                newTab={page === 'table'}
              />
            )}
            {open === 'messages' && <Messages talkTo={talkTo} onTalkTo={setTalkTo} />}
            {open === 'history' && (
              <HistoryList
                recent={recent}
                board={board}
                onBoard={setBoard}
                newTab={page === 'table'}
              />
            )}
          </Body>
        </Content>
      )}
      <Rail ref={rail} role="tablist" aria-orientation={phone ? 'horizontal' : 'vertical'} $compact={compact}>
        {tabs.map((name) => {
          const Icon = icon[name]
          return (
            <RailButton
              key={name}
              type="button"
              data-tab={name}
              role="tab"
              aria-selected={open === name}
              $active={open === name}
              $compact={compact}
              onClick={() => toggle(name)}
              title={label[name]}
              aria-label={
                unread[name] ? `${label[name]} · ${t.tabUnread(unread[name])}` : undefined
              }
            >
              <Icon size={22} aria-hidden />
              {label[name]}
              {!!unread[name] && <RailBadge aria-hidden $compact={compact}>{unread[name]}</RailBadge>}
            </RailButton>
          )
        })}
      </Rail>
    </Dock>
  )
}

// ── People ────────────────────────────────────────────────────────────────────────────────────

function People({ onMessage, newTab }: { onMessage?: (userId: string) => void; newTab: boolean }) {
  const { lobby, send } = useClub()
  const { user } = useAuth()
  return (
    <PeopleList lobby={lobby} userId={user?.id} send={send} onMessage={onMessage} newTab={newTab} />
  )
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────

function Messages({
  talkTo,
  onTalkTo,
}: {
  talkTo: string | null
  onTalkTo: (userId: string | null) => void
}) {
  const { lobby, directs, directLive, send } = useClub()
  const { user } = useAuth()
  const load = useCallback(
    (userId: string, before?: number) => api.directMessages(userId, before),
    [],
  )
  return (
    <DirectMessages
      me={user?.id}
      directs={directs}
      live={directLive}
      members={lobby?.members ?? []}
      blocked={lobby?.blocked ?? []}
      talkTo={talkTo}
      onTalkTo={onTalkTo}
      send={send}
      load={load}
    />
  )
}

// ── History ───────────────────────────────────────────────────────────────────────────────────

const Toggle = styled.div`
  display: flex;
  gap: 6px;
  padding: 10px 12px 6px;
`

const ToggleButton = styled.button<{ $active: boolean }>`
  flex: 1;
  min-height: 32px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $active }) => ($active ? theme.colors.primary : theme.colors.surface)};
  color: ${({ theme, $active }) => ($active ? theme.colors.onPrimary : theme.colors.text)};
  font-size: 14px;
  font-weight: 700;
`

const Row = styled.button`
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 2px 10px;
  width: 100%;
  padding: 8px 14px;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  background: none;
  text-align: left;
  font-size: 15px;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
`

/** One pair under a board's title, on a line of its own; a long name ends in an ellipsis */
const Pair = styled.span`
  grid-column: 1 / -1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  line-height: 1.4;

  & > b {
    display: inline-block;
    min-width: 22px;
    margin-right: 4px;
    font-weight: 700;
  }
`

const BoardNo = styled.span`
  font-weight: 800;
  color: ${({ theme }) => theme.colors.primary};
`

const Score = styled.span<{ $value: number }>`
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: ${({ theme, $value }) => ($value > 0 ? theme.colors.success : $value < 0 ? theme.colors.danger : 'inherit')};
`

const DayRow = styled.button`
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
  text-align: left;
  font-size: 15px;
  font-weight: 600;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
`

/** Above one day's boards: the way back to the dates, and which day this is */
const DayBar = styled.div`
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

const AllRow = styled.div`
  padding: 8px 10px;
`

const MoreRow = styled.div`
  display: flex;
  justify-content: center;
  padding: 8px 10px 0;
`

/** Links that would leave the table page open in a new tab there, since leaving the page leaves the table */
const NEW_TAB = { target: '_blank', rel: 'noopener' } as const

/**
 * 「本桌」 lists its boards straight when it has at most this many (the table keeps its latest 30),
 * by day like 「我的」 when it has more (e3-t48)
 */
export const TABLE_FLAT_MAX = 20
/** One day's boards come this many at a time */
const DAY_PAGE = 20

/** A board in the list: number, contract and result, the NS score on the right; then NS, then EW, a line each */
function BoardRow({ board: b, onOpen }: { board: BoardSummary; onOpen: () => void }) {
  const { t } = usePreferences()
  const pair = (a: PublicUser, c: PublicUser) => `${playerName(t, a)} – ${playerName(t, c)}`
  const ns = pair(b.players.N, b.players.S)
  const ew = pair(b.players.E, b.players.W)
  return (
    <Row type="button" onClick={onOpen}>
      <BoardNo>#{b.boardNo}</BoardNo>
      <ContractResult contract={b.contract} tricks={b.result.declarerTricks} />
      <Score $value={b.result.scoreNS}>{signed(b.result.scoreNS)}</Score>
      <Pair title={ns}>
        <b>NS</b>
        {ns}
      </Pair>
      <Pair title={ew}>
        <b>EW</b>
        {ew}
      </Pair>
    </Row>
  )
}

/** Boards grouped by Taiwan date, newest day first, as the server counts them */
function daysOf(boards: BoardSummary[]): HistoryDay[] {
  const days: HistoryDay[] = []
  for (const b of [...boards].sort((x, y) => y.finishedAt - x.finishedAt)) {
    const date = taiwanDate(b.finishedAt)
    const last = days.at(-1)
    if (last?.date === date) last.count++
    else days.push({ date, count: 1 })
  }
  return days
}

const GROUPING_KEY = 'tku-bridge-table:side-grouping'

function readGrouping(): RecordGrouping {
  try {
    const stored = window.localStorage.getItem(GROUPING_KEY)
    return isGrouping(stored) ? stored : 'date'
  } catch {
    return 'date'
  }
}

function writeGrouping(grouping: RecordGrouping) {
  try {
    window.localStorage.setItem(GROUPING_KEY, grouping)
  } catch {
    // Not remembered; the list still changes
  }
}

const GroupingRow = styled.div`
  display: flex;
  justify-content: center;
  padding: 6px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
`

/** 「我的」 before any group is picked: every board I played */
const MINE: HistoryQuery = { ...DEFAULT_HISTORY_QUERY, scope: 'mine', size: DAY_PAGE }

/**
 * The history tab (e3-t48, 社長 2026-10-27): grouped as on 牌局紀錄 (`RecordGroups`) — by date
 * first, each date with how many boards were played that day; by topic first (一般牌桌, 挑戰,
 * 隊制賽, 練習, then the dates); or not at all — the choice remembered in the browser. A group
 * opens its boards, a page at a time, with a way back. 「本桌」 with few boards lists them straight,
 * by day when there are more. A board opens right in the panel, in the record page's own view.
 */
export function HistoryList({
  recent,
  board,
  onBoard,
  newTab,
}: {
  recent?: BoardSummary[]
  board: string | null
  onBoard: (id: string | null) => void
  newTab: boolean
}) {
  const { t, lang } = usePreferences()
  const [scope, setScope] = useState<'table' | 'mine'>(recent ? 'table' : 'mine')
  const [grouping, setGrouping] = useState<RecordGrouping>(readGrouping)
  const [topic, setTopic] = useState<HistoryMode | null>(null)
  const [day, setDay] = useState<string | null>(null)
  // Reload my boards whenever a board finishes here
  const latest = recent?.[0]?.id

  if (board) return <BoardInPanel id={board} onBack={() => onBoard(null)} newTab={newTab} />

  const choose = (next: 'table' | 'mine') => {
    setScope(next)
    setTopic(null)
    setDay(null)
  }
  const regroup = (next: RecordGrouping) => {
    setGrouping(next)
    writeGrouping(next)
    setTopic(null)
    setDay(null)
  }

  const dayName = (date: string) =>
    formatDay(date, lang, { today: t.timeToday, yesterday: t.timeYesterday })
  const boards = (list: BoardSummary[]) => (
    <div>
      {list.map((b) => (
        <BoardRow key={b.id} board={b} onOpen={() => onBoard(b.id)} />
      ))}
    </div>
  )

  let body: ReactNode
  if (scope === 'mine')
    body = (
      <>
        <GroupingRow>
          <GroupingSwitch value={grouping} onChange={regroup} />
        </GroupingRow>
        <RecordGroups
          query={MINE}
          grouping={grouping}
          topic={topic}
          day={day}
          onTopic={(next) => {
            setTopic(next)
            setDay(null)
          }}
          onDay={setDay}
          empty={<Empty>{t.historyEmpty}</Empty>}
          reload={latest}
        >
          {(query) => (
            <SideBoards
              key={historyQueryString(query)}
              query={query}
              reload={latest}
              onOpen={onBoard}
            />
          )}
        </RecordGroups>
      </>
    )
  else if ((recent?.length ?? 0) <= TABLE_FLAT_MAX)
    body = !recent?.length ? <Empty>{t.noBoardsHere}</Empty> : boards(recent)
  else if (!day)
    body = (
      <div role="list" aria-label={t.historyByDay}>
        {daysOf(recent ?? []).map((d) => (
          <div role="listitem" key={d.date}>
            <DayRow type="button" onClick={() => setDay(d.date)}>
              <span>{dayName(d.date)}</span>
              <small>{t.dayBoards(d.count)}</small>
            </DayRow>
          </div>
        ))}
      </div>
    )
  else
    body = (
      <>
        <DayBar>
          <ActionButton back onClick={() => setDay(null)}>
            {t.backToDays}
          </ActionButton>
          <strong>{dayName(day)}</strong>
        </DayBar>
        {boards((recent ?? []).filter((b) => taiwanDate(b.finishedAt) === day))}
      </>
    )

  return (
    <>
      {recent && (
        <Toggle role="group" aria-label={t.tabHistory}>
          <ToggleButton
            type="button"
            $active={scope === 'table'}
            aria-pressed={scope === 'table'}
            onClick={() => choose('table')}
          >
            {t.thisTable}
          </ToggleButton>
          <ToggleButton
            type="button"
            $active={scope === 'mine'}
            aria-pressed={scope === 'mine'}
            onClick={() => choose('mine')}
          >
            {t.myBoards}
          </ToggleButton>
        </Toggle>
      )}
      {body}
      <AllRow>
        <ActionLink to="/history" {...(newTab ? NEW_TAB : {})}>
          {t.historyTitle}
        </ActionLink>
      </AllRow>
    </>
  )
}

/** One group's boards in the panel, DAY_PAGE at a time, 「載入更多」 for the next */
function SideBoards({
  query: given,
  reload,
  onOpen,
}: {
  query: HistoryQuery
  reload: unknown
  onOpen: (id: string) => void
}) {
  const { t } = usePreferences()
  const [loaded, setLoaded] = useState<{
    boards: BoardSummary[]
    total: number
    page: number
  } | null>(null)
  const [more, setMore] = useState(false)

  // The search stays the same for the life of this list (it is the list's key)
  const [query] = useState(given)
  useEffect(() => {
    let cancelled = false
    api
      .searchHistory({ ...query, page: 1 })
      .then(
        (page) =>
          !cancelled && setLoaded({ boards: page.boards, total: page.total, page: page.page }),
      )
      .catch(() => !cancelled && setLoaded({ boards: [], total: 0, page: 1 }))
    return () => {
      cancelled = true
    }
  }, [query, reload])

  const loadMore = (now: { page: number }) => {
    setMore(true)
    api
      .searchHistory({ ...query, page: now.page + 1 })
      .then((page) =>
        setLoaded(
          (had) =>
            had && {
              boards: [
                ...had.boards,
                ...page.boards.filter((b) => !had.boards.some((x) => x.id === b.id)),
              ],
              total: page.total,
              page: page.page,
            },
        ),
      )
      .catch(() => undefined)
      .finally(() => setMore(false))
  }

  if (!loaded) return <Empty>{t.loading}</Empty>
  if (loaded.boards.length === 0) return <Empty>{t.historyEmpty}</Empty>
  return (
    <>
      <div>
        {loaded.boards.map((b) => (
          <BoardRow key={b.id} board={b} onOpen={() => onOpen(b.id)} />
        ))}
      </div>
      {loaded.boards.length < loaded.total && (
        <MoreRow>
          <Button
            type="button"
            $size="sm"
            $busy={more}
            disabled={more}
            onClick={() => loadMore(loaded)}
          >
            {t.historyMore}
          </Button>
        </MoreRow>
      )}
    </>
  )
}

// ── One board, inside the panel ──────────────────────────────────────────────────────────────

const BoardBar = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  font-weight: 700;
`

const BackButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  font-size: 14px;
  font-weight: 600;
`

const PanelRecord = styled.div`
  padding: 8px 10px 12px;
`

/**
 * A finished board in the side panel: the record page's own view (`BoardRecordView` with
 * `compact`), so it has everything the page has — the replay with 雙夢家模式, the auction and the
 * result, the double-dummy table and the play record — sized for the panel
 */
function BoardInPanel({ id, onBack, newTab }: { id: string; onBack: () => void; newTab: boolean }) {
  const { t } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)

  useEffect(() => {
    let cancelled = false
    api.record(id).then(({ record }) => !cancelled && setRecord(record))
    return () => {
      cancelled = true
    }
  }, [id])

  return (
    <>
      <BoardBar>
        <BackButton type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
          {t.tabHistory}
        </BackButton>
        {record && (
          <span>
            {boardPlace(t, record)} #{record.board.boardNo}
          </span>
        )}
      </BoardBar>
      {!record ? (
        <Empty>{t.loading}</Empty>
      ) : (
        <PanelRecord>
          <BoardRecordView key={record.id} record={record} compact newTab={newTab} />
        </PanelRecord>
      )}
    </>
  )
}
