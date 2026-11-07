import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { BoardRecord, LobbyView, Me, SharedBoard } from '../../shared/protocol.ts'
import { ApiError } from '../../src/lib/api.ts'
import { BoardRecordView } from '../../src/components/BoardRecordView.tsx'
import { BoardShareDialog } from '../../src/components/BoardShareDialog.tsx'
import { SharedBoardPage } from '../../src/pages/SharedBoardPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** J8: PBN and a session's LIN from a record (e4-t36, e4-t37), and a board's public link (e4-t38) */

const mocks = vi.hoisted(() => ({
  api: {
    boardShare: vi.fn(),
    createBoardShare: vi.fn(),
    revokeBoardShare: vi.fn(),
    sharedBoard: vi.fn(),
    sessionLinPath: (id: string) => `/api/history/${id}/session.lin`,
  },
  download: { saveText: vi.fn(), downloadFile: vi.fn(async () => new Headers()) },
  user: { id: 'amy', username: 'amy', admin: false, permissions: [], features: [] } as Me | null,
}))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('../../src/lib/download.ts', () => mocks.download)
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
  useSignedIn: () => false,
  useFeature: () => false,
}))
const LOBBY: LobbyView = { online: [], members: [], tables: [], myTableId: null, friends: [], blocked: [] }
vi.mock('../../src/state/ClubContext.tsx', () => ({ useClub: () => ({ lobby: LOBBY, send: vi.fn() }), useLobby: () => LOBBY }))
vi.mock('../../src/components/DoubleDummyPanel.tsx', () => ({ DoubleDummyPanel: () => null }))
vi.mock('../../src/components/FeaturedPanel.tsx', () => ({ FeaturedPanel: () => null }))

const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

function playedBoard(): BoardState {
  let board: BoardState = newBoard(1, hands)
  for (const call of ['7D', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  return board
}

function record(id: string, extra: Partial<BoardRecord> = {}): BoardRecord {
  const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'Robot', robot: true, robotKind: 'gib' as const })
  return {
    id,
    tableNumber: 3,
    finishedAt: 0,
    players: { N: robot('N'), E: { id: 'cat', username: 'cat' }, S: { id: 'amy', username: 'amy' }, W: robot('W') },
    board: playedBoard(),
    ...extra,
  }
}

const renderAt = (path: string, ui: React.ReactNode, route = path) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={route} element={ui} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user = { id: 'amy', username: 'amy', admin: false, permissions: [], features: [] }
})

describe('downloads from a record (e4-t36, e4-t37)', () => {
  it('saves the board as PBN and asks the server for the session’s LIN', async () => {
    renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    await userEvent.click(screen.getByRole('button', { name: '下載 PBN' }))
    expect(mocks.download.saveText).toHaveBeenCalledWith('tku-board-1-b1.pbn', expect.stringContaining('[Contract "7D"]'))
    await userEvent.click(screen.getByRole('button', { name: '下載整場 LIN' }))
    expect(mocks.download.downloadFile).toHaveBeenCalledWith('/api/history/b1/session.lin', 'tku-session-b1.lin')
    // The first render of a record page loads a lot; a slow machine needs the time
  }, 30_000)

  it('shows why the session could not be downloaded', async () => {
    mocks.download.downloadFile.mockRejectedValueOnce(new ApiError('x', 404, 'boardGone'))
    renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    await userEvent.click(screen.getByRole('button', { name: '下載整場 LIN' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('找不到這副牌')
  })
})

describe('the public link button (e4-t38)', () => {
  it('is for the board’s players and the admins, and waits for a board kept back', () => {
    const { unmount } = renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    expect(screen.getByRole('button', { name: '公開分享連結' })).toBeEnabled()
    unmount()
    mocks.user = { id: 'ben', username: 'ben', admin: false, permissions: [], features: [] }
    const other = renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    expect(screen.queryByRole('button', { name: '公開分享連結' })).toBeNull()
    other.unmount()
    mocks.user = { id: 'boss', username: 'boss', admin: true, permissions: [], features: [] }
    const admin = renderAt('/history/b1', <BoardRecordView record={record('b1')} />)
    expect(screen.getByRole('button', { name: '公開分享連結' })).toBeEnabled()
    admin.unmount()
    mocks.user = { id: 'amy', username: 'amy', admin: false, permissions: [], features: [] }
    renderAt('/history/b2', <BoardRecordView record={record('b2', { revealAt: Date.now() + 60_000 })} />)
    expect(screen.getByRole('button', { name: '公開分享連結' })).toBeDisabled()
  })

  it('makes a link, shows it and takes it back', async () => {
    mocks.api.boardShare.mockResolvedValue({ share: null })
    mocks.api.createBoardShare.mockResolvedValue({ share: { token: 'a'.repeat(32), createdAt: 0, createdBy: { id: 'amy', username: 'amy' } } })
    mocks.api.revokeBoardShare.mockResolvedValue({ ok: true })
    renderAt('/history/b1', <BoardShareDialog boardId="b1" onClose={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: '產生連結' }))
    expect(mocks.api.createBoardShare).toHaveBeenCalledWith('b1')
    expect(await screen.findByRole('textbox', { name: '公開分享連結' })).toHaveValue(`${window.location.origin}/share/${'a'.repeat(32)}`)
    await userEvent.click(screen.getByRole('button', { name: '撤銷連結' }))
    expect(mocks.api.revokeBoardShare).toHaveBeenCalledWith('b1')
    expect(await screen.findByRole('status')).toHaveTextContent('已撤銷')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: '產生連結' })).toBeInTheDocument()
  })
})

describe('a board opened by its public link (e4-t38)', () => {
  const shared = (): SharedBoard => ({
    board: playedBoard(),
    finishedAt: 0,
    players: { N: { name: 'Robot', robot: true, robotKind: 'gib' }, E: { name: null }, S: { name: 'amy' }, W: { name: 'Robot', robot: true } },
  })

  it('shows the board, a member who keeps their boards private unnamed, and links nowhere else', async () => {
    mocks.user = null
    mocks.api.sharedBoard.mockResolvedValue({ shared: shared() })
    renderAt(`/share/${'b'.repeat(32)}`, <SharedBoardPage />, '/share/:token')
    expect(await screen.findByRole('heading', { name: '第 1 副' })).toBeInTheDocument()
    expect(mocks.api.sharedBoard).toHaveBeenCalledWith('b'.repeat(32))
    expect(screen.getAllByText(/社員/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/amy/).length).toBeGreaterThan(0)
    const links = screen.getAllByRole('link')
    // Home for a visitor is the platform's page: the root is 淡江's sign-in
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/about'])
  })

  it('says when the link is gone', async () => {
    mocks.user = null
    mocks.api.sharedBoard.mockRejectedValue(new ApiError('x', 404, 'shareGone'))
    renderAt('/share/zzz', <SharedBoardPage />, '/share/:token')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('這個連結不存在或已經撤銷'))
  })
})
