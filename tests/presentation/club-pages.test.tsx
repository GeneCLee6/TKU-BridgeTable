import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuestTable, PublicTable } from '../../shared/public-lobby.ts'
import { TableSettingsDialog } from '../../src/components/TableSettingsDialog.tsx'
import { request } from '../../src/lib/api.ts'
import { appPath, clubBase, clubHeaders, clubStorageKey, currentClub, pathInClub, plainAddress, setClubFromPath, withClub } from '../../src/lib/club.ts'
import { GuestTablePage, PublicLobbyPage } from '../../src/pages/PublicLobbyPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Club addresses (e12-t04) and the cross-club lobby (e12-t07) in the browser */

const mocks = vi.hoisted(() => ({
  publicLobby: vi.fn(),
  guestTable: vi.fn(),
  feature: true,
}))
vi.mock('../../src/lib/api.ts', async (original) => {
  const real = await original<typeof import('../../src/lib/api.ts')>()
  return { ...real, api: { ...real.api, publicLobby: mocks.publicLobby, guestTable: mocks.guestTable } }
})
vi.mock('../../src/state/AuthContext.tsx', () => ({ useFeature: () => mocks.feature, useAuth: () => ({ user: null }) }))

afterEach(() => {
  setClubFromPath('/')
  vi.unstubAllGlobals()
})

describe('the club of the page (src/lib/club.ts)', () => {
  it('is 淡江 at the plain addresses, with nothing added to any call', () => {
    expect(setClubFromPath('/table/abc')).toBe('tku')
    expect(clubBase()).toBe('')
    expect(appPath('/share/x')).toBe('/share/x')
    expect(withClub('/api/avatar/u1?v=2')).toBe('/api/avatar/u1?v=2')
    expect(clubHeaders().has('X-Club-Id')).toBe(false)
    expect(clubStorageKey('draft')).toBe('draft')
  })

  it('is another club under /c/<id>/, which every link, call and socket names', () => {
    expect(setClubFromPath('/c/ntu/table/abc')).toBe('ntu')
    expect(currentClub()).toBe('ntu')
    expect(clubBase()).toBe('/c/ntu')
    expect(appPath('/share/x')).toBe('/c/ntu/share/x')
    expect(pathInClub('/c/ntu/table/abc')).toBe('/table/abc')
    expect(pathInClub('/c/ntu')).toBe('/')
    expect(withClub('/api/avatar/u1?v=2')).toBe('/api/avatar/u1?v=2&club=ntu')
    expect(withClub('/ws')).toBe('/ws?club=ntu')
    expect(clubHeaders({ 'Content-Type': 'application/json' }).get('X-Club-Id')).toBe('ntu')
    expect(clubStorageKey('draft')).toBe('draft@ntu')
  })

  it('sends 淡江 under /c/tku/ to its plain address', () => {
    expect(plainAddress('/c/tku/table/abc', '?challenge=c1', '#x')).toBe('/table/abc?challenge=c1#x')
    expect(plainAddress('/c/tku', '', '')).toBe('/')
    expect(plainAddress('/c/ntu/table/abc')).toBeNull()
    expect(plainAddress('/table/abc')).toBeNull()
  })

  it('names the club on every API call', async () => {
    const fetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    setClubFromPath('/c/ntu/')
    await request('/api/me')
    await request('/api/account/avatar', { method: 'PUT', body: 'x', headers: { 'Content-Type': 'image/webp' } })
    const headers = (fetch.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => new Headers(init.headers))
    expect(headers.map((h) => h.get('X-Club-Id'))).toEqual(['ntu', 'ntu'])
    expect(headers[1].get('Content-Type')).toBe('image/webp')
  })
})

describe('opening a table to other clubs (e12-t07)', () => {
  it('is offered to a host whose club joined the cross-club lobby', async () => {
    mocks.feature = true
    const onSubmit = vi.fn()
    render(
      <PreferencesProvider>
        <TableSettingsDialog title="開新桌" submitLabel="開桌" onSubmit={onSubmit} onClose={() => {}} />
      </PreferencesProvider>,
    )
    const dialog = screen.getByRole('dialog', { name: '開新桌' })
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /開放其他社團觀看/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '開桌' }))
    expect(onSubmit).toHaveBeenCalledWith({ access: 'public', allowKibitz: true, boardMinutes: 0, openToClubs: true }, [])
  })

  it('is not offered without it, and a table that had it is closed to them again', async () => {
    mocks.feature = false
    const onSubmit = vi.fn()
    render(
      <PreferencesProvider>
        <TableSettingsDialog
          title="牌桌設定"
          submitLabel="儲存"
          initial={{ access: 'public', allowKibitz: true, boardMinutes: 0, openToClubs: true }}
          onSubmit={onSubmit}
          onClose={() => {}}
        />
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('checkbox', { name: /開放其他社團觀看/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '儲存' }))
    expect(onSubmit).toHaveBeenCalledWith({ access: 'public', allowKibitz: true, boardMinutes: 0, openToClubs: false }, [])
    mocks.feature = true
  })
})

describe('the cross-club lobby (e12-t07)', () => {
  const seats = { N: { username: 'TKB', robot: true as const, online: true }, E: null, S: { username: 'gene', online: true }, W: null }

  it('lists the other clubs’ open tables with each club’s name, to watch', async () => {
    const table: PublicTable = { clubId: 'ntu', clubName: '台大橋藝社', tableId: 't1', number: 2, seats, boardsPlayed: 3, playing: true }
    mocks.publicLobby.mockResolvedValue({ tables: [table] })
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <PublicLobbyPage />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    const row = await screen.findByRole('region', { name: '台大橋藝社・第 2 桌' })
    expect(within(row).getByText(/gene/)).toBeInTheDocument()
    expect(within(row).getByText(/打牌中/)).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: /觀看/ })).toHaveAttribute('href', '/clubs/ntu/t1')
  })

  it('says when no other club has a table open', async () => {
    mocks.publicLobby.mockResolvedValue({ tables: [] })
    render(
      <PreferencesProvider>
        <MemoryRouter>
          <PublicLobbyPage />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(await screen.findByText('現在沒有其他社團開放觀看的牌桌。')).toBeInTheDocument()
  })

  const watch = () =>
    render(
      <PreferencesProvider>
        <MemoryRouter initialEntries={['/clubs/ntu/t1']}>
          <Routes>
            <Route path="/clubs/:clubId/:tableId" element={<GuestTablePage />} />
          </Routes>
        </MemoryRouter>
      </PreferencesProvider>,
    )

  it('shows a table of another club to watch only, with no seat or chat to use', async () => {
    const table: GuestTable = {
      clubId: 'ntu',
      clubName: '台大橋藝社',
      tableId: 't1',
      number: 2,
      seats,
      boardsPlayed: 0,
      board: null,
    }
    mocks.guestTable.mockResolvedValue({ table })
    watch()
    expect(await screen.findByText(/你以其他社團訪客的身分觀看/)).toBeInTheDocument()
    expect(mocks.guestTable).toHaveBeenCalledWith('ntu', 't1')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: /入座|坐/ })).toBeNull()
  })

  it('says when the table closed or is no longer open to other clubs', async () => {
    const { ApiError } = await import('../../src/lib/api.ts')
    mocks.guestTable.mockRejectedValue(new ApiError('gone', 404, 'tableGone'))
    watch()
    expect(await screen.findByRole('alert')).toHaveTextContent('這張牌桌已經關閉，或不再開放其他社團觀看。')
  })
})
