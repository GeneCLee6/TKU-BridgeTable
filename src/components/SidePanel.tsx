import { ArrowLeft, BookOpen, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, History, Mail, MessageSquare, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { handviewerUrl } from '../../shared/lin.ts'
import { taiwanDate } from '../../shared/history-query.ts'
import type { BoardRecord, BoardSummary, HistoryDay, PublicUser } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDay, signed } from '../lib/format.ts'
import { useTrickReplay } from '../lib/useTrickReplay.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile, tablet } from '../styles/tokens.ts'
import { boardPlace, playerName } from '../strings.ts'
import { AuctionBox } from './AuctionBox.tsx'
import { DirectMessages } from './DirectMessages.tsx'
import { FavoriteButton } from './FavoriteButton.tsx'
import { PeopleList } from './PeopleList.tsx'
import { PlayedCardsSwitch, RecordDiagram } from './RecordDiagram.tsx'
import { ActionButton, ActionLink, Button } from './ui.tsx'
import { ContractResult } from './Suit.tsx'

/**
 * BBO's right-hand dock: a narrow strip of tabs on the far right (chat, people, messages, history). Clicking
 * a tab opens its panel beside the strip; clicking it again closes the panel, so the table gets
 * the space back. History opens a board right in the panel, so you can keep playing on the left
 * and look at an earlier board on the right. The open tab is remembered per page. There is no ✕ on
 * the panel (e3-t47): the strip is always beside it (below it on a phone), and Esc inside the panel
 * closes it too, handing the focus back to its tab.
 */

export type PanelTab = 'chat' | 'people' | 'messages' | 'history' | 'conventions'

const Dock = styled.div`
  position: relative;
  display: flex;
  min-height: 0;
  height: 100%;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};

  ${mobile} {
    flex-direction: column-reverse;
    height: auto;
    border-left: 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
`

const Rail = styled.nav`
  display: flex;
  flex-direction: column;
  flex: none;
  width: 68px;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};

  ${mobile} {
    flex-direction: row;
    width: 100%;
    border-left: 0;
  }
`

const RailButton = styled.button<{ $active: boolean }>`
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

  &:hover { background: ${({ theme }) => theme.colors.surface}; }
  ${({ $active, theme }) =>
    $active &&
    css`
      border-left-color: ${theme.colors.primary};
      background: ${theme.colors.surface};
      color: ${theme.colors.primary};
    `}

  ${mobile} {
    flex: 1;
    min-height: 52px;
    border-left: 0;
    border-top: 3px solid ${({ $active, theme }) => ($active ? theme.colors.primary : 'transparent')};
  }
`

const RailBadge = styled.span`
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
`

const Content = styled.section<{ $wide: boolean }>`
  display: flex;
  flex-direction: column;
  width: ${({ $wide }) => ($wide ? 420 : 320)}px;
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

  ${mobile} {
    width: 100%;
    min-height: 320px;
  }
`

const ContentHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 46px;
  padding: 0 14px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 800;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
  const [open, setOpen] = useState<PanelTab | null>(() => {
    const stored = readOpen(page, initial)
    return stored && tabs.includes(stored) ? stored : null
  })
  const [board, setBoard] = useState<string | null>(null)
  const [talkTo, setTalkTo] = useState<string | null>(null)
  const { directs } = useClub()
  const icon = { chat: MessageSquare, people: Users, messages: Mail, history: History, conventions: BookOpen }
  const label = {
    chat: t.tabChat,
    people: t.tabPeople,
    messages: t.tabMessages,
    history: t.tabHistory,
    conventions: t.tabConventions,
  }
  const unread = { messages: directs?.unread ?? 0 } as Partial<Record<PanelTab, number>>

  const toggle = (tab: PanelTab) => {
    const next = open === tab ? null : tab
    setOpen(next)
    writeOpen(page, next)
  }
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
    setOpen('messages')
    writeOpen(page, 'messages')
  }

  return (
    <Dock aria-label={t.sidePanel} data-tour="side">
      {open && (
        <Content $wide={open === 'history' && board !== null} role="tabpanel" aria-label={label[open]} onKeyDown={closeOnEscape}>
          <ContentHead>
            <span>{label[open]}</span>
          </ContentHead>
          <Body>
            {open === 'chat' && chat}
            {open === 'conventions' && conventions}
            {open === 'people' && <People onMessage={tabs.includes('messages') ? message : undefined} newTab={page === 'table'} />}
            {open === 'messages' && <Messages talkTo={talkTo} onTalkTo={setTalkTo} />}
            {open === 'history' && <HistoryList recent={recent} board={board} onBoard={setBoard} newTab={page === 'table'} />}
          </Body>
        </Content>
      )}
      <Rail ref={rail} role="tablist" aria-orientation="vertical">
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
              onClick={() => toggle(name)}
              title={label[name]}
              aria-label={unread[name] ? `${label[name]} · ${t.tabUnread(unread[name])}` : undefined}
            >
              <Icon size={22} aria-hidden />
              {label[name]}
              {!!unread[name] && <RailBadge aria-hidden>{unread[name]}</RailBadge>}
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
  return <PeopleList lobby={lobby} userId={user?.id} send={send} onMessage={onMessage} newTab={newTab} />
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────────

function Messages({ talkTo, onTalkTo }: { talkTo: string | null; onTalkTo: (userId: string | null) => void }) {
  const { lobby, directs, directLive, send } = useClub()
  const { user } = useAuth()
  const load = useCallback((userId: string, before?: number) => api.directMessages(userId, before), [])
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

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
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

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
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

/** One day's boards of 「我的」, as far as they were loaded */
interface DayBoards {
  date: string
  boards: BoardSummary[]
  total: number
  page: number
}

/**
 * The history tab (e3-t48): first the days, each with how many boards were played that day; a day
 * opens its boards, a page at a time, with a way back to the days. 「本桌」 with few boards lists
 * them straight. A board opens right in the panel.
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
  const [day, setDay] = useState<string | null>(null)
  const [days, setDays] = useState<HistoryDay[] | null>(null)
  const [dayBoards, setDayBoards] = useState<DayBoards | null>(null)
  const [more, setMore] = useState(false)
  // Reload my boards whenever a board finishes here
  const latest = recent?.[0]?.id

  useEffect(() => {
    if (scope !== 'mine') return
    let cancelled = false
    api
      .historyDays({ scope: 'mine' })
      .then((answer) => !cancelled && setDays(answer.days))
      .catch(() => !cancelled && setDays([]))
    return () => {
      cancelled = true
    }
  }, [scope, latest])

  useEffect(() => {
    if (scope !== 'mine' || !day) return
    let cancelled = false
    api
      .searchHistory({ scope: 'mine', from: day, to: day, size: DAY_PAGE })
      .then((page) => !cancelled && setDayBoards({ date: day, boards: page.boards, total: page.total, page: page.page }))
      .catch(() => !cancelled && setDayBoards({ date: day, boards: [], total: 0, page: 1 }))
    return () => {
      cancelled = true
    }
  }, [scope, day, latest])

  if (board) return <BoardInPanel id={board} onBack={() => onBoard(null)} newTab={newTab} />

  const choose = (next: 'table' | 'mine') => {
    setScope(next)
    setDay(null)
  }
  const loadMore = (loaded: DayBoards) => {
    setMore(true)
    api
      .searchHistory({ scope: 'mine', from: loaded.date, to: loaded.date, size: DAY_PAGE, page: loaded.page + 1 })
      .then((page) =>
        setDayBoards((now) =>
          now?.date === loaded.date
            ? {
                ...now,
                boards: [...now.boards, ...page.boards.filter((b) => !now.boards.some((had) => had.id === b.id))],
                total: page.total,
                page: page.page,
              }
            : now,
        ),
      )
      .catch(() => undefined)
      .finally(() => setMore(false))
  }

  const byDay = scope === 'mine' || (recent?.length ?? 0) > TABLE_FLAT_MAX
  const shownDays = scope === 'mine' ? days : daysOf(recent ?? [])
  const shownDay = scope === 'mine' && dayBoards?.date === day ? dayBoards : null
  const dayList = scope === 'mine' ? shownDay?.boards : recent?.filter((b) => taiwanDate(b.finishedAt) === day)
  const dayName = (date: string) => formatDay(date, lang, { today: t.timeToday, yesterday: t.timeYesterday })
  const boards = (list: BoardSummary[]) => (
    <div>
      {list.map((b) => (
        <BoardRow key={b.id} board={b} onOpen={() => onBoard(b.id)} />
      ))}
    </div>
  )

  let body: ReactNode
  if (!byDay) body = !recent?.length ? <Empty>{t.noBoardsHere}</Empty> : boards(recent)
  else if (!day)
    body = !shownDays ? (
      <Empty>{t.loading}</Empty>
    ) : shownDays.length === 0 ? (
      <Empty>{scope === 'table' ? t.noBoardsHere : t.historyEmpty}</Empty>
    ) : (
      <div role="list" aria-label={t.historyByDay}>
        {shownDays.map((d) => (
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
        {!dayList ? <Empty>{t.loading}</Empty> : boards(dayList)}
        {shownDay && shownDay.boards.length < shownDay.total && (
          <MoreRow>
            <Button type="button" $size="sm" $busy={more} disabled={more} onClick={() => loadMore(shownDay)}>
              {t.historyMore}
            </Button>
          </MoreRow>
        )}
      </>
    )

  return (
    <>
      {recent && (
        <Toggle role="group" aria-label={t.tabHistory}>
          <ToggleButton type="button" $active={scope === 'table'} aria-pressed={scope === 'table'} onClick={() => choose('table')}>
            {t.thisTable}
          </ToggleButton>
          <ToggleButton type="button" $active={scope === 'mine'} aria-pressed={scope === 'mine'} onClick={() => choose('mine')}>
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

const PanelDiagram = styled.div`
  margin: 8px 6px;
`

const SwitchRow = styled.div`
  display: flex;
  justify-content: center;
  padding: 8px 0 0;
`

const Controls = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  & > span { min-width: 48px; text-align: center; font-size: 13px; }
`

const SmallButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 32px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  &:disabled { opacity: 0.45; }
`

const Facts = styled.div`
  display: grid;
  gap: 8px;
  justify-items: center;
  padding: 8px 12px 12px;
  font-size: 14px;
`

/** A finished board in the side panel: deal, replay, auction and result */
function BoardInPanel({ id, onBack, newTab }: { id: string; onBack: () => void; newTab: boolean }) {
  const { t } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)
  const replay = useTrickReplay(record?.board.play.length ?? 0)
  const { step } = replay

  useEffect(() => {
    let cancelled = false
    api.record(id).then(({ record }) => !cancelled && setRecord(record))
    return () => {
      cancelled = true
    }
  }, [id])

  if (!record)
    return (
      <>
        <BoardBar>
          <BackButton type="button" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
            {t.tabHistory}
          </BackButton>
        </BoardBar>
        <Empty>{t.loading}</Empty>
      </>
    )

  const { board } = record
  const total = board.play.length
  const result = board.result!

  return (
    <>
      <BoardBar>
        <BackButton type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
          {t.tabHistory}
        </BackButton>
        <span>
          {boardPlace(t, record)} #{board.boardNo}
        </span>
      </BoardBar>
      <PanelDiagram>
        <RecordDiagram record={record} step={step} width={48} trickWidth={30} styleFor={() => 'text'} compact />
      </PanelDiagram>
      {total > 0 && (
        <Controls role="group" aria-label={t.replay}>
          <SmallButton type="button" onClick={replay.start} aria-label={t.start}>
            <ChevronFirst size={16} aria-hidden />
          </SmallButton>
          <SmallButton type="button" onClick={replay.prev} disabled={replay.playing || step === 0} aria-label={t.prevTrick}>
            <ChevronLeft size={16} aria-hidden />
          </SmallButton>
          <span aria-label={t.trickProgress(replay.trick, replay.tricks)}>
            {replay.trick}/{replay.tricks}
          </span>
          <SmallButton type="button" onClick={replay.next} disabled={replay.playing || step >= total} aria-label={t.nextTrick}>
            <ChevronRight size={16} aria-hidden />
          </SmallButton>
          <SmallButton type="button" onClick={replay.end} aria-label={t.end}>
            <ChevronLast size={16} aria-hidden />
          </SmallButton>
        </Controls>
      )}
      {total > 0 && (
        <SwitchRow>
          <PlayedCardsSwitch />
        </SwitchRow>
      )}
      <Facts>
        <strong>
          <ContractResult contract={board.contract} tricks={result.declarerTricks} /> · NS {signed(result.scoreNS)}
        </strong>
        <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} size={44} />
        <span>
          <FavoriteButton boardId={id} />
          <Link to={`/history/${id}`} {...(newTab ? NEW_TAB : {})}>
            {t.openFullPage}
          </Link>{' '}
          ·{' '}
          <a href={handviewerUrl(record)} target="_blank" rel="noopener">
            BBO Handviewer
          </a>
        </span>
      </Facts>
    </>
  )
}
