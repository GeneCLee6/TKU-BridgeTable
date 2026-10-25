import { ArrowLeft, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, History, Mail, MessageSquare, Users, X } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { handviewerUrl } from '../../shared/lin.ts'
import type { BoardRecord, BoardSummary, PublicUser } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useTrickReplay } from '../lib/useTrickReplay.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { playerName } from '../strings.ts'
import { AuctionBox } from './AuctionBox.tsx'
import { DirectMessages } from './DirectMessages.tsx'
import { FavoriteButton } from './FavoriteButton.tsx'
import { PeopleList } from './PeopleList.tsx'
import { PlayedCardsSwitch, RecordDiagram } from './RecordDiagram.tsx'
import { ContractResult } from './Suit.tsx'

/**
 * BBO's right-hand dock: a narrow strip of tabs on the far right (chat, people, messages, history). Clicking
 * a tab opens its panel beside the strip; clicking it again closes the panel, so the table gets
 * the space back. History opens a board right in the panel, so you can keep playing on the left
 * and look at an earlier board on the right. The open tab is remembered per page.
 */

export type PanelTab = 'chat' | 'people' | 'messages' | 'history'

const Dock = styled.div`
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
  padding: 0 8px 0 14px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  font-weight: 800;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: ${({ theme }) => theme.colors.textMuted};
  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
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
  recent,
}: {
  tabs: PanelTab[]
  /** Remembers which tab is open separately for each page ('table', 'lobby') */
  page: string
  initial?: PanelTab | null
  chat?: ReactNode
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
  const icon = { chat: MessageSquare, people: Users, messages: Mail, history: History }
  const label = { chat: t.tabChat, people: t.tabPeople, messages: t.tabMessages, history: t.tabHistory }
  const unread = { messages: directs?.unread ?? 0 } as Partial<Record<PanelTab, number>>

  const toggle = (tab: PanelTab) => {
    const next = open === tab ? null : tab
    setOpen(next)
    writeOpen(page, next)
  }

  /** The People tab's envelope: opens that conversation in the Messages tab */
  const message = (userId: string) => {
    setTalkTo(userId)
    setOpen('messages')
    writeOpen(page, 'messages')
  }

  return (
    <Dock aria-label={t.sidePanel}>
      {open && (
        <Content $wide={open === 'history' && board !== null} role="tabpanel" aria-label={label[open]}>
          <ContentHead>
            <span>{label[open]}</span>
            <IconButton type="button" onClick={() => toggle(open)} aria-label={t.close} title={t.close}>
              <X size={18} aria-hidden />
            </IconButton>
          </ContentHead>
          <Body>
            {open === 'chat' && chat}
            {open === 'people' && <People onMessage={tabs.includes('messages') ? message : undefined} />}
            {open === 'messages' && <Messages talkTo={talkTo} onTalkTo={setTalkTo} />}
            {open === 'history' && <HistoryList recent={recent} board={board} onBoard={setBoard} newTab={page === 'table'} />}
          </Body>
        </Content>
      )}
      <Rail role="tablist" aria-orientation="vertical">
        {tabs.map((name) => {
          const Icon = icon[name]
          return (
            <RailButton
              key={name}
              type="button"
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

function People({ onMessage }: { onMessage?: (userId: string) => void }) {
  const { lobby, send } = useClub()
  const { user } = useAuth()
  return <PeopleList lobby={lobby} userId={user?.id} send={send} onMessage={onMessage} />
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
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 2px 10px;
  width: 100%;
  padding: 8px 14px;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  background: none;
  text-align: left;
  font-size: 15px;

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
  & > small { grid-column: 1 / -1; color: ${({ theme }) => theme.colors.textMuted}; font-size: 12px; }
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

const Empty = styled.p`
  margin: 0;
  padding: 14px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

const AllLink = styled(Link)`
  display: block;
  padding: 12px 14px;
  font-size: 14px;
`

/** Links that would leave the table page open in a new tab there, since leaving the page leaves the table */
const NEW_TAB = { target: '_blank', rel: 'noopener' } as const

function HistoryList({
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
  const [mine, setMine] = useState<BoardSummary[] | null>(null)
  // Reload my boards whenever a board finishes here
  const finished = recent?.length ?? 0

  useEffect(() => {
    if (scope !== 'mine') return
    let cancelled = false
    api
      .history(false)
      .then((page) => !cancelled && setMine(page.boards.slice(0, 30)))
      .catch(() => !cancelled && setMine([]))
    return () => {
      cancelled = true
    }
  }, [scope, finished])

  if (board) return <BoardInPanel id={board} onBack={() => onBoard(null)} newTab={newTab} />

  const boards = scope === 'table' ? recent : mine
  const name = (u: PublicUser) => playerName(t, u)

  return (
    <>
      {recent && (
        <Toggle role="group" aria-label={t.tabHistory}>
          <ToggleButton type="button" $active={scope === 'table'} aria-pressed={scope === 'table'} onClick={() => setScope('table')}>
            {t.thisTable}
          </ToggleButton>
          <ToggleButton type="button" $active={scope === 'mine'} aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>
            {t.myBoards}
          </ToggleButton>
        </Toggle>
      )}
      {!boards ? (
        <Empty>{t.loading}</Empty>
      ) : boards.length === 0 ? (
        <Empty>{scope === 'table' ? t.noBoardsHere : t.historyEmpty}</Empty>
      ) : (
        <div>
          {boards.map((b) => (
            <Row key={b.id} type="button" onClick={() => onBoard(b.id)}>
              <BoardNo>#{b.boardNo}</BoardNo>
              <span>
                <ContractResult contract={b.contract} tricks={b.result.declarerTricks} />
              </span>
              <Score $value={b.result.scoreNS}>{signed(b.result.scoreNS)}</Score>
              <small>
                {formatDateTime(b.finishedAt, lang)} · {name(b.players.N)}–{name(b.players.S)} / {name(b.players.E)}–
                {name(b.players.W)}
              </small>
            </Row>
          ))}
        </div>
      )}
      <AllLink to="/history" {...(newTab ? NEW_TAB : {})}>
        {t.historyTitle} →
      </AllLink>
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
          {record.mode === 'challenge' ? t.challenge : t.tableName(record.tableNumber)} #{board.boardNo}
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
