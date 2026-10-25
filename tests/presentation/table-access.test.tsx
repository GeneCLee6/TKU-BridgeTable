import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LobbyView, TableSummary } from '../../shared/protocol.ts'
import { JoinRequests } from '../../src/components/TablePanels.tsx'
import { LobbyPage } from '../../src/pages/LobbyPage.tsx'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The four access modes in the browser: the lobby's badges, asking to join, and the host's answers */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  lobby: null as LobbyView | null,
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { challenges: () => Promise.resolve({ challenges: [] }) },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby: mocks.lobby, send: mocks.send, notifications: null, status: 'open', table: null, error: null }),
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'bob', username: 'bob', admin: false, permissions: [] } }),
}))

const tableSummary = (id: string, number: number, extra: Partial<TableSummary>): TableSummary => ({
  id,
  number,
  hostName: 'gene',
  settings: { access: 'public', allowKibitz: true, boardMinutes: 0 },
  welcome: true,
  seats: { N: null, E: null, S: { id: 'gene', username: 'gene', online: true }, W: null },
  spectators: 0,
  boardsPlayed: 0,
  boardNo: null,
  ...extra,
})

const lobbyWith = (tables: TableSummary[]): LobbyView => ({
  online: [],
  members: [],
  tables,
  myTableId: null,
  friends: [],
  blocked: [],
})

beforeEach(() => {
  mocks.send.mockReset()
})

const show = (ui: React.ReactNode, path = '/') =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/table/:tableId" element={ui} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

describe('the lobby card', () => {
  it('shows a badge for a request or closed table, and asks to join instead of watching', async () => {
    mocks.lobby = lobbyWith([
      tableSummary('t1', 1, { settings: { access: 'request', allowKibitz: true, boardMinutes: 0 }, welcome: false }),
      tableSummary('t2', 2, { settings: { access: 'closed', allowKibitz: true, boardMinutes: 0 }, welcome: false }),
      tableSummary('t3', 3, {}),
    ])
    show(<LobbyPage />)
    const request = screen.getByLabelText('第 1 桌')
    expect(within(request).getByText('申請加入', { selector: 'span' })).toBeInTheDocument()
    await userEvent.click(within(request).getByRole('button', { name: '申請加入' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'requestJoin', tableId: 't1' })

    const closed = screen.getByLabelText('第 2 桌')
    expect(within(closed).getByText('已關閉')).toBeInTheDocument()
    expect(within(closed).getByRole('button', { name: '觀看' })).toBeDisabled()

    // A public table has no access badge
    const open = screen.getByLabelText('第 3 桌')
    expect(within(open).queryByText('已關閉')).toBeNull()
    expect(within(open).getByRole('button', { name: '觀看' })).toBeEnabled()
  })

  it('says the request is waiting', () => {
    mocks.lobby = lobbyWith([
      tableSummary('t1', 1, { settings: { access: 'request', allowKibitz: true, boardMinutes: 0 }, welcome: false, requested: true }),
    ])
    show(<LobbyPage />)
    expect(screen.getByRole('button', { name: '已送出申請，等房主回覆' })).toBeDisabled()
  })
})

describe('coming to a table one may not enter', () => {
  it('offers to ask at a request table', async () => {
    mocks.lobby = lobbyWith([
      tableSummary('t1', 1, { settings: { access: 'request', allowKibitz: true, boardMinutes: 0 }, welcome: false }),
    ])
    show(<TablePage />, '/table/t1')
    expect(screen.getByText('這一桌要先申請，房主同意後才能入座或觀看。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '申請加入' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'requestJoin', tableId: 't1' })
    expect(mocks.send).not.toHaveBeenCalledWith({ type: 'joinTable', tableId: 't1' })
  })

  it('says a closed table takes nobody new', () => {
    mocks.lobby = lobbyWith([
      tableSummary('t2', 2, { settings: { access: 'closed', allowKibitz: true, boardMinutes: 0 }, welcome: false }),
    ])
    show(<TablePage />, '/table/t2')
    expect(screen.getByText('這一桌目前不接受新的人入座或觀看。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '申請加入' })).toBeNull()
  })
})

describe('the host’s requests', () => {
  it('lists who asked, with let in and decline', async () => {
    const onAnswer = vi.fn()
    render(
      <PreferencesProvider>
        <JoinRequests
          requests={[
            { user: { id: 'b1', username: 'bob' }, at: 1 },
            { user: { id: 'c1', username: 'cleo' }, at: 2 },
          ]}
          onAnswer={onAnswer}
        />
      </PreferencesProvider>,
    )
    const box = screen.getByRole('region', { name: '加入申請' })
    expect(within(box).getByText('bob 想加入這一桌')).toBeInTheDocument()
    await userEvent.click(within(box).getAllByRole('button', { name: '同意' })[0])
    expect(onAnswer).toHaveBeenCalledWith('b1', true)
    await userEvent.click(within(box).getAllByRole('button', { name: '拒絕' })[1])
    expect(onAnswer).toHaveBeenCalledWith('c1', false)
  })

  it('shows nothing when nobody is waiting', () => {
    const { container } = render(
      <PreferencesProvider>
        <JoinRequests requests={[]} onAnswer={() => {}} />
      </PreferencesProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
