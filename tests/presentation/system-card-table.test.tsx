import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveCard } from '../../shared/robot/system/card.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { setClubFromPath } from '../../src/lib/club.ts'
import { legalCalls } from '../../shared/auction.ts'
import type { BoardView, LobbyView, TableView } from '../../shared/protocol.ts'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** Opening a system card from a seat during play (e5-t52, AC-5.11): it tells nothing about the deal */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
}))

const lobby: LobbyView = { online: [], members: [], tables: [], myTableId: 't1', friends: [], blocked: [] }

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { challenges: () => Promise.resolve({ challenges: [] }) },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
  useLobby: () => lobby,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
  useFeature: () => false,
}))

const s = STRINGS.zh.systemCard

const robot = (kind: 'gib' | 'tku', seat: string) => ({ id: `robot:${kind}:${seat}`, username: 'TKB', robot: true, robotKind: kind, online: true })

function tableWith(hand: string[], extra: Partial<TableView> = {}): TableView {
  return {
    id: 't1',
    number: 1,
    hostId: 'bob',
    settings: { access: 'public', allowKibitz: true, boardMinutes: 0 },
    seats: { N: { id: 'bob', username: 'bob', online: true }, E: robot('gib', 'E'), S: { id: 'amy', username: 'amy', online: true }, W: robot('tku', 'W') },
    spectators: [],
    mySeat: 'S',
    board: {
      boardNo: 1,
      dealer: 'S',
      vul: 'None',
      phase: 'auction',
      hands: { S: hand },
      handCounts: { N: 13, E: 13, S: 13, W: 13 },
      auction: [],
      contract: null,
      dummy: null,
      turn: 'S',
      tricks: [],
      tricksWon: { NS: 0, EW: 0 },
      legalCards: [],
      legalCalls: [...legalCalls([], 'S')],
      canUndo: false,
      canClaim: false,
    } as BoardView,
    boardsPlayed: 0,
    dealAt: null,
    chat: [],
    recent: [],
    boardEndsAt: null,
    waiting: null,
    ...extra,
  } as TableView
}

const showTable = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/table/t1']}>
        <Routes>
          <Route path="/table/:tableId" element={<TablePage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

const plate = (seat: string) => document.querySelector<HTMLElement>(`[data-seat="${seat}"]`)!

async function openCard(seat: string, name: string) {
  await userEvent.click(plate(seat))
  await userEvent.click(screen.getByRole('menuitem', { name: s.open(name) }))
  const dialog = screen.getByRole('dialog', { name: s.cardOf(name) })
  await within(dialog).findByText(s.sections.leads, {}, { timeout: 10_000 })
  return dialog
}

const HAND_A = ['SA', 'SK', 'SQ', 'SJ', 'HA', 'HK', 'HQ', 'DA', 'DK', 'DQ', 'CA', 'CK', 'CQ']
const HAND_B = ['S2', 'S3', 'S4', 'S5', 'H2', 'H3', 'H4', 'D2', 'D3', 'D4', 'C2', 'C3', 'C4']

const server = vi.fn()

beforeEach(() => {
  mocks.send.mockReset()
  server.mockReset()
  server.mockImplementation(async () => new Response(JSON.stringify(deriveCard(TKU))))
  vi.stubGlobal('fetch', server)
})

afterEach(() => {
  setClubFromPath('/')
})

describe('a seat’s system card at the table', () => {
  it('a robot’s seat opens the card of its own system', async () => {
    mocks.table = tableWith(HAND_A)
    showTable()
    const gib = await openCard('E', '2/1')
    expect(gib.textContent).toContain('RKCB 0314')
    await userEvent.click(within(gib).getByRole('button', { name: STRINGS.zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const tku = await openCard('W', STRINGS.zh.robotSystems.tku)
    expect(tku.textContent).toContain('RKCB 1430')
  })

  it('in another club a 淡江 robot’s seat does not offer the club’s card; a 2/1 robot’s does', async () => {
    setClubFromPath('/c/ntu/table/t1')
    mocks.table = tableWith(HAND_A)
    showTable()
    // Nothing else to do with that seat either, so it is not even a button
    expect(plate('W').tagName).toBe('DIV')
    await openCard('E', '2/1')
    expect(server.mock.calls.flat().join()).not.toContain('system-card')
  })

  it('a person’s seat offers no card: their system is not known, so nothing is guessed', async () => {
    mocks.table = tableWith(HAND_A)
    showTable()
    // Not the host, and the seat is taken: nothing to do with it at all
    expect(plate('N').tagName).toBe('DIV')
  })

  it('reads the same whatever the deal, and the card shows no hand', async () => {
    mocks.table = tableWith(HAND_A)
    const first = showTable()
    const a = (await openCard('E', '2/1')).textContent
    first.unmount()
    mocks.table = tableWith(HAND_B)
    showTable()
    const b = (await openCard('E', '2/1')).textContent
    expect(b).toBe(a)
  })

  it('the club’s card asks only for the card: nothing about the table goes to the server', async () => {
    mocks.table = tableWith(HAND_A)
    showTable()
    server.mockClear()
    await openCard('W', STRINGS.zh.robotSystems.tku)
    const asked = server.mock.calls.filter(([url]) => String(url).includes('system-card'))
    expect(asked).toHaveLength(1)
    expect(asked[0][0]).toBe('/api/system-card/tku')
    expect(asked[0][1].body).toBeUndefined()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('tells the table nothing, stays on the table, and the keyboard does not bid behind it', async () => {
    mocks.table = tableWith(HAND_A)
    showTable()
    await openCard('E', '2/1')
    mocks.send.mockClear()
    await userEvent.keyboard('1np')
    expect(mocks.send).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    // Nothing was chosen behind the dialog, so Enter has nothing to send
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('works at a practice table too, where a seat has no other actions', async () => {
    mocks.table = tableWith(HAND_A, {
      hostId: 'amy',
      practice: { deal: 'random', robotKind: 'gib', justDeclare: false, dealt: 1 },
    } as Partial<TableView>)
    showTable()
    const dialog = await openCard('E', '2/1')
    expect(dialog).toBeTruthy()
  })
})
