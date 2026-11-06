import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardView, LobbyView, TableView } from '../../shared/protocol.ts'
import { LobbyPage } from '../../src/pages/LobbyPage.tsx'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** A failure in the dock beside the table stays there, and the lobby's entry to 搭檔叫牌 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
  lobby: null as LobbyView | null,
  broken: new Set<string>(),
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { challenges: () => Promise.resolve({ challenges: [] }) },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: mocks.lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
  useLobby: () => mocks.lobby,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
  useFeature: () => false,
}))
vi.mock('../../src/components/ChatPanel.tsx', () => ({
  ChatPanel: () => {
    if (mocks.broken.has('chat')) throw new Error('chat broke')
    return <div>聊天內容</div>
  },
}))
vi.mock('../../src/components/SupportDialog.tsx', () => ({
  SupportDialog: () => {
    if (mocks.broken.has('support')) throw new Error('support broke')
    return <div role="dialog">回報對話框</div>
  },
}))
vi.mock('../../src/components/TableTour.tsx', () => ({ TableTour: () => null }))

const person = (id: string) => ({ id, username: id, online: true })
const table = {
  id: 't1',
  number: 1,
  hostId: 'amy',
  settings: { access: 'public', allowKibitz: true, boardMinutes: 0 },
  seats: { N: person('bob'), E: person('cat'), S: person('amy'), W: person('dan') },
  spectators: [],
  mySeat: 'S',
  board: {
    boardNo: 1,
    dealer: 'S',
    vul: 'None',
    phase: 'auction',
    hands: { S: ['SA', 'SK', 'SQ', 'SJ', 'HA', 'HK', 'HQ', 'DA', 'DK', 'DQ', 'CA', 'CK', 'CQ'] },
    handCounts: { N: 13, E: 13, S: 13, W: 13 },
    auction: [],
    contract: null,
    dummy: null,
    turn: 'S',
    tricks: [],
    tricksWon: { NS: 0, EW: 0 },
    legalCards: [],
    legalCalls: ['P', '1C'],
    canUndo: false,
    canClaim: false,
  } as BoardView,
  boardsPlayed: 0,
  dealAt: null,
  chat: [],
  recent: [],
  boardEndsAt: null,
  waiting: null,
} as unknown as TableView

const atTable: LobbyView = { online: [], members: [], tables: [], myTableId: 't1', friends: [], blocked: [] }

const showTable = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/table/t1']}>
        <Routes>
          <Route path="/table/:tableId" element={<TablePage />} />
          <Route path="/" element={<div>大廳</div>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  mocks.send.mockReset()
  mocks.broken.clear()
  mocks.table = table
  mocks.lobby = atTable
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'zh', tableTourSeen: true }))
})

afterEach(() => {
  localStorage.removeItem('tku-bridge-table:prefs')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a failure beside the table', () => {
  it('leaves the hand and the bidding box when the chat fails, and says so in the dock', () => {
    mocks.broken.add('chat')
    showTable()
    expect(document.querySelector('[data-hand="S"]')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('tabpanel')).toHaveTextContent(STRINGS.zh.errorBoundary.part)
    expect(screen.getByRole('group', { name: STRINGS.zh.biddingBox })).toBeInTheDocument()
  })

  it('lets the member open another tab of the dock after one failed', async () => {
    mocks.broken.add('chat')
    showTable()
    await userEvent.click(screen.getByRole('tab', { name: STRINGS.zh.tabConventions }))
    expect(screen.queryByText(STRINGS.zh.errorBoundary.part)).toBeNull()
  })

  it('closes a dialog that fails, leaving the table, and opens it again once it works', async () => {
    mocks.broken.add('support')
    showTable()
    await userEvent.click(screen.getByRole('button', { name: STRINGS.zh.support.open }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('[data-hand="S"]')).not.toBeNull()
    mocks.broken.delete('support')
    await userEvent.click(screen.getByRole('button', { name: STRINGS.zh.support.open }))
    expect(screen.getByRole('dialog')).toHaveTextContent('回報對話框')
  })

  it('still leaves the table when the member goes away from a failed table screen', async () => {
    // A seat the table screen cannot read fails the screen itself, not only a part of it
    mocks.table = { ...table, seats: null } as unknown as TableView
    showTable()
    expect(screen.getByRole('alert')).toHaveTextContent(STRINGS.zh.errorBoundary.title)
    // The page around the screen is still there: failing is not leaving, going away is
    expect(mocks.send).not.toHaveBeenCalledWith({ type: 'leaveTable' })
    await userEvent.click(screen.getByRole('link', { name: STRINGS.zh.errorBoundary.home }))
    expect(screen.getByText('大廳')).toBeInTheDocument()
    expect(mocks.send).toHaveBeenCalledWith({ type: 'leaveTable' })
  })
})

describe('the lobby’s entry to 搭檔叫牌', () => {
  const showLobby = (myTableMode?: 'practice') => {
    mocks.table = null
    mocks.lobby = { online: [], members: [], tables: [], myTableId: myTableMode ? 't9' : null, ...(myTableMode && { myTableMode }), friends: [], blocked: [] } as LobbyView
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <LobbyPage />
        </MemoryRouter>
      </PreferencesProvider>,
    )
  }

  it('sits next to the practice button and leads to the page', () => {
    showLobby()
    const link = screen.getByRole('link', { name: STRINGS.zh.partnerBid.lobbyEntry })
    expect(link).toHaveAttribute('href', '/partner-bidding')
    const practice = screen.getByRole('button', { name: STRINGS.zh.practiceOpen })
    expect(practice.parentElement).toBe(link.parentElement)
  })

  it('has its name in six languages', () => {
    for (const t of Object.values(STRINGS)) expect(t.partnerBid.lobbyEntry).toBeTruthy()
  })
})
