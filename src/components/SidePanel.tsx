import { History, MessageSquare, Users, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { resultLabel } from '../../shared/scoring.ts'
import type { BoardRecord, BoardSummary, MemberStatus, PublicUser } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { BoardRecordView } from '../pages/BoardPage.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { seatLetter } from '../strings.ts'
import { ContractLabel } from './Suit.tsx'

/**
 * The right-hand panel, as on BBO: tabs for chat (at a table), people (who is online and where)
 * and history (boards from this table or your own, opened in a dialog without leaving the table).
 */

export type PanelTab = 'chat' | 'people' | 'history'

const Panel = styled.aside`
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};

  ${mobile} {
    border-left: 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
    min-height: 360px;
  }
`

const Tabs = styled.div`
  display: flex;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
`

const Tab = styled.button<{ $active: boolean }>`
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  border: 0;
  border-bottom: 3px solid transparent;
  background: none;
  font-weight: 700;
  color: ${({ theme }) => theme.colors.textMuted};
  ${({ $active, theme }) =>
    $active &&
    css`
      color: ${theme.colors.primary};
      border-bottom-color: ${theme.colors.primary};
      background: ${theme.colors.primarySoft};
    `}
`

const Body = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
`

export function SidePanel({
  tabs,
  initial,
  header,
  chat,
  recent,
}: {
  tabs: PanelTab[]
  initial?: PanelTab
  /** Shown above the tabs (the table's title and buttons) */
  header?: ReactNode
  chat?: ReactNode
  /** Boards finished at the current table; enables the "this table" history view */
  recent?: BoardSummary[]
}) {
  const { t } = usePreferences()
  const [tab, setTab] = useState<PanelTab>(initial ?? tabs[0])
  const icon = { chat: MessageSquare, people: Users, history: History }
  const label = { chat: t.tabChat, people: t.tabPeople, history: t.tabHistory }

  return (
    <Panel aria-label={t.sidePanel}>
      {header}
      <Tabs role="tablist">
        {tabs.map((name) => {
          const Icon = icon[name]
          return (
            <Tab key={name} type="button" role="tab" aria-selected={tab === name} $active={tab === name} onClick={() => setTab(name)}>
              <Icon size={17} aria-hidden />
              {label[name]}
            </Tab>
          )
        })}
      </Tabs>
      <Body role="tabpanel">
        {tab === 'chat' && chat}
        {tab === 'people' && <PeopleList />}
        {tab === 'history' && <HistoryList recent={recent} />}
      </Body>
    </Panel>
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

function HistoryList({ recent }: { recent?: BoardSummary[] }) {
  const { t, lang } = usePreferences()
  const [scope, setScope] = useState<'table' | 'mine'>(recent ? 'table' : 'mine')
  const [mine, setMine] = useState<BoardSummary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
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
            <Row key={b.id} type="button" onClick={() => setOpen(b.id)}>
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
      {open && <BoardDialog id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

// ── Board dialog ──────────────────────────────────────────────────────────────────────────────

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Dialog = styled.div`
  position: relative;
  width: min(1080px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 16px 20px 20px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.bg};
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
`

const DialogBar = styled.div`
  position: sticky;
  top: -16px;
  z-index: 1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: -16px -20px 0;
  padding: 10px 12px;
  background: ${({ theme }) => theme.colors.bg};
`

const CloseButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 0 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  font-weight: 600;
`

/** A finished board over the table, so players can look back without leaving their seat */
export function BoardDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)

  useEffect(() => {
    let cancelled = false
    api.record(id).then(({ record }) => !cancelled && setRecord(record))
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKey)
    }
  }, [id, onClose])

  return (
    <Backdrop onClick={onClose}>
      <Dialog role="dialog" aria-modal="true" aria-label={t.tabHistory} onClick={(e) => e.stopPropagation()}>
        <DialogBar>
          <Link to={`/history/${id}`}>{t.openFullPage}</Link>
          <CloseButton type="button" onClick={onClose} autoFocus>
            <X size={16} aria-hidden />
            {t.close}
          </CloseButton>
        </DialogBar>
        {record ? <BoardRecordView record={record} embedded /> : <Empty>{t.loading}</Empty>}
      </Dialog>
    </Backdrop>
  )
}
