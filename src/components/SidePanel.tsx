import { ArrowLeft, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, History, MessageSquare, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { remainingCards, tricksOf } from '../../shared/game.ts'
import { handviewerUrl } from '../../shared/lin.ts'
import type { BoardRecord, BoardSummary, MemberStatus, PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { seatLetter } from '../strings.ts'
import { AuctionBox } from './AuctionBox.tsx'
import { BoardInfo } from './BoardInfo.tsx'
import { HandView } from './HandView.tsx'
import { ContractLabel } from './Suit.tsx'
import { TrickArea, TrickSpace, type Position } from './TrickArea.tsx'

/**
 * BBO's right-hand dock: a narrow strip of tabs on the far right (chat, people, history). Clicking
 * a tab opens its panel beside the strip; clicking it again closes the panel, so the table gets
 * the space back. History opens a board right in the panel, so you can keep playing on the left
 * and look at an earlier board on the right. The open tab is remembered per page.
 */

export type PanelTab = 'chat' | 'people' | 'history'

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
  const icon = { chat: MessageSquare, people: Users, history: History }
  const label = { chat: t.tabChat, people: t.tabPeople, history: t.tabHistory }

  const toggle = (tab: PanelTab) => {
    const next = open === tab ? null : tab
    setOpen(next)
    writeOpen(page, next)
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
            {open === 'people' && <PeopleList />}
            {open === 'history' && <HistoryList recent={recent} board={board} onBoard={setBoard} />}
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
            >
              <Icon size={22} aria-hidden />
              {label[name]}
            </RailButton>
          )
        })}
      </Rail>
    </Dock>
  )
}

// ── People ────────────────────────────────────────────────────────────────────────────────────

const Group = styled.h3`
  margin: 0;
  padding: 10px 14px 4px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  font-weight: 700;
`

const Person = styled.li<{ $online: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  opacity: ${({ $online }) => ($online ? 1 : 0.6)};
`

const Dot = styled.span<{ $online: boolean }>`
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${({ theme, $online }) => ($online ? theme.colors.success : theme.colors.border)};
`

const PersonName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
`

const Where = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  white-space: nowrap;
`

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`

function PeopleList() {
  const { t } = usePreferences()
  const { lobby } = useClub()
  const { user } = useAuth()
  const members = lobby?.members ?? []
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)
  const where = (m: MemberStatus) => {
    if (m.tableNumber === null) return m.online ? t.inLobby : ''
    const table = lobby?.tables.find((x) => x.number === m.tableNumber)
    const text = t.atTable(m.tableNumber, m.seat ? seatLetter[m.seat] : null)
    return table && m.id !== user?.id ? <Link to={`/table/${table.id}`}>{text}</Link> : text
  }
  const row = (m: MemberStatus) => (
    <Person key={m.id} $online={m.online}>
      <Dot $online={m.online} aria-label={m.online ? t.online : t.offline} />
      <PersonName>
        {m.username}
        {m.id === user?.id && t.youTag}
      </PersonName>
      <Where>{where(m)}</Where>
    </Person>
  )
  return (
    <div>
      <Group>{t.onlineCount(online.length)}</Group>
      <List>{online.map(row)}</List>
      <Group>{t.offlineCount(offline.length)}</Group>
      <List>{offline.map(row)}</List>
    </div>
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

function HistoryList({
  recent,
  board,
  onBoard,
}: {
  recent?: BoardSummary[]
  board: string | null
  onBoard: (id: string | null) => void
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

  if (board) return <BoardInPanel id={board} onBack={() => onBoard(null)} />

  const boards = scope === 'table' ? recent : mine
  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)

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
                <ContractLabel contract={b.contract} />
                {b.contract && ` ${resultLabel(b.contract, b.result.declarerTricks)}`}
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
      <AllLink to="/history">{t.historyTitle} →</AllLink>
    </>
  )
}

// ── One board, inside the panel ──────────────────────────────────────────────────────────────

const POSITIONS: Record<Position, Seat> = { top: 'N', right: 'E', bottom: 'S', left: 'W' }
const positionOf = (seat: Seat) => (Object.keys(POSITIONS) as Position[]).find((p) => POSITIONS[p] === seat)!

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

const Diagram = styled.div`
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  grid-template-areas:
    'info top .'
    'left center right'
    '. bottom .';
  align-items: center;
  justify-items: center;
  gap: 6px;
  margin: 8px;
  padding: 8px 4px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.table.felt};
  color: ${({ theme }) => theme.table.feltText};
`

const Spot = styled.div<{ $area: string }>`
  grid-area: ${({ $area }) => $area};
  display: grid;
  justify-items: center;
  gap: 2px;
  min-width: 0;
  font-size: 12px;
  font-weight: 700;
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
`

const Facts = styled.div`
  display: grid;
  gap: 8px;
  justify-items: center;
  padding: 8px 12px 12px;
  font-size: 14px;
`

/** A finished board in the side panel: deal, replay, auction and result */
function BoardInPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)
  const [step, setStep] = useState(0)

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

  const { board, players } = record
  const total = board.play.length
  const shown = { ...board, play: board.play.slice(0, step) }
  const current = tricksOf(shown).at(-1)
  const go = (n: number) => setStep(Math.max(0, Math.min(total, n)))
  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)
  const result = board.result!

  return (
    <>
      <BoardBar>
        <BackButton type="button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden />
          {t.tabHistory}
        </BackButton>
        <span>
          {t.tableName(record.tableNumber)} #{board.boardNo}
        </span>
      </BoardBar>
      <Diagram>
        <Spot $area="info">
          <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={POSITIONS} size={16} />
        </Spot>
        {SEATS.map((seat) => (
          <Spot key={seat} $area={positionOf(seat)}>
            <span>
              {seatLetter[seat]} {name(players[seat])}
            </span>
            <HandView
              cards={step === 0 ? board.hands[seat] : remainingCards(shown, seat)}
              count={13}
              width={30}
              style="text"
              label={`${seatLetter[seat]} ${name(players[seat])}`}
            />
          </Spot>
        ))}
        <Spot $area="center">
          {current && step > 0 ? (
            <TrickArea cards={current.cards} positionOf={positionOf} winner={current.winner} width={30} label={t.thisTrick} />
          ) : (
            <TrickSpace $w={30} />
          )}
        </Spot>
      </Diagram>
      {total > 0 && (
        <Controls role="group" aria-label={t.replay}>
          <SmallButton type="button" onClick={() => go(0)} aria-label={t.start}>
            <ChevronFirst size={16} aria-hidden />
          </SmallButton>
          <SmallButton type="button" onClick={() => go(step - 1)} aria-label={t.prev}>
            <ChevronLeft size={16} aria-hidden />
          </SmallButton>
          <span>
            {step}/{total}
          </span>
          <SmallButton type="button" onClick={() => go(step + 1)} aria-label={t.next}>
            <ChevronRight size={16} aria-hidden />
          </SmallButton>
          <SmallButton type="button" onClick={() => go(total)} aria-label={t.end}>
            <ChevronLast size={16} aria-hidden />
          </SmallButton>
        </Controls>
      )}
      <Facts>
        <strong>
          <ContractLabel contract={board.contract} />
          {board.contract && ` · ${result.declarerTricks} ${t.tricks}（${resultLabel(board.contract, result.declarerTricks)}）`} ·{' '}
          {t.ns} {signed(result.scoreNS)}
        </strong>
        <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} size={44} />
        <span>
          <Link to={`/history/${id}`}>{t.openFullPage}</Link> ·{' '}
          <a href={handviewerUrl(record)} target="_blank" rel="noopener">
            BBO Handviewer
          </a>
        </span>
      </Facts>
    </>
  )
}
