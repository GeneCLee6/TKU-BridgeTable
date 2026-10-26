import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { legalCalls } from '../../shared/auction.ts'
import { parseHand } from '../../shared/pbn.ts'
import type { SavedPractice } from '../../shared/practice.ts'
import type { BoardView, LobbyView, TableView } from '../../shared/protocol.ts'
import { PracticeBanner } from '../../src/components/PracticeBanner.tsx'
import { PracticeDialog } from '../../src/components/PracticeDialog.tsx'
import { conditionsOf, formsOf } from '../../src/lib/practiceForm.ts'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/**
 * The bidding practice room, part two, in the browser (`e10-t16`): each seat's conditions or whole
 * hand, contradictions told before sending, saved settings, deal sets, and 顯示四家 at the table
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
  presets: [] as SavedPractice[],
  save: vi.fn(),
  remove: vi.fn(),
}))

const lobby: LobbyView = { online: [], members: [], tables: [], myTableId: 'p1', myTableMode: 'practice', friends: [], blocked: [] }

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: {
    challenges: () => Promise.resolve({ challenges: [] }),
    practicePresets: () => Promise.resolve({ presets: mocks.presets }),
    savePracticePreset: mocks.save,
    removePracticePreset: mocks.remove,
    practiceSets: () => Promise.resolve({ sets: [{ id: 'sample', count: 3, categories: ['notrump'] }] }),
    favorites: () =>
      Promise.resolve({
        boards: [{ id: 'b1', boardNo: 7, finishedAt: Date.UTC(2026, 9, 20) }],
        total: 1,
        page: 1,
        size: 50,
        favorites: [],
        tags: [],
      }),
    featured: () => Promise.resolve({ featured: [] }),
  },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
  useLobby: () => lobby,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }),
}))

beforeEach(() => {
  mocks.send.mockReset()
  mocks.save.mockReset()
  mocks.remove.mockReset()
  mocks.presets = []
})

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)
const open = (onSubmit = vi.fn()) => {
  wrap(<PracticeDialog onSubmit={onSubmit} onClose={() => {}} />)
  return onSubmit
}

describe('PracticeDialog: each seat (e10-t16)', () => {
  it('sets each of the four seats: points, a shape shortcut, or a whole hand typed', async () => {
    const onSubmit = open()
    await userEvent.click(screen.getByRole('radio', { name: /自訂條件/ }))
    await userEvent.click(screen.getByRole('tab', { name: /東/ }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '牌型' }), '任一門六張以上')
    await userEvent.click(screen.getByRole('tab', { name: /西/ }))
    await userEvent.click(screen.getByRole('radio', { name: '指定整手牌' }))
    await userEvent.type(screen.getByPlaceholderText('AKQ2.K73.9.AJ852'), 'AKQ2.K73.9.AJ852')
    expect(screen.getByText('已選 13／13 張')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith(
      {
        deal: 'custom',
        robotKind: 'gib',
        justDeclare: false,
        conditions: { seats: { E: { longest: [6, 13] }, S: { hcp: [12, 37] }, W: { hand: parseHand('AKQ2.K73.9.AJ852') } } },
      },
      'hidden',
    )
  })

  it('picks a hand card by card, and not a card another seat holds', async () => {
    open()
    await userEvent.click(screen.getByRole('radio', { name: /自訂條件/ }))
    await userEvent.click(screen.getByRole('radio', { name: '指定整手牌' }))
    await userEvent.click(screen.getByRole('button', { name: '黑桃A' }))
    await userEvent.click(screen.getByRole('button', { name: '紅心K' }))
    expect(screen.getByPlaceholderText('AKQ2.K73.9.AJ852')).toHaveValue('A.K..')
    expect(screen.getByText('已選 2／13 張')).toBeInTheDocument()
    // Not yet 13 cards: told, and nothing is sent
    expect(screen.getByRole('alert')).toHaveTextContent('南指定的牌要剛好 13 張')
    expect(screen.getByRole('button', { name: '開始練習' })).toBeDisabled()
    await userEvent.click(screen.getByRole('tab', { name: /北/ }))
    await userEvent.click(screen.getByRole('radio', { name: '指定整手牌' }))
    expect(screen.getByRole('button', { name: '黑桃A' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '黑桃K' })).toBeEnabled()
  })

  it('says where the conditions contradict each other before anything is sent', async () => {
    open()
    await userEvent.click(screen.getByRole('radio', { name: /自訂條件/ }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '牌型' }), '平均牌型')
    const spadesFrom = screen.getByRole('spinbutton', { name: '♠ 張數 最少' })
    await userEvent.clear(spadesFrom)
    await userEvent.type(spadesFrom, '6')
    expect(screen.getByRole('alert')).toHaveTextContent('南的牌型條件互相矛盾')
    expect(screen.getByRole('button', { name: '開始練習' })).toBeDisabled()
  })

  it('turns a saved setting back into the same form', () => {
    const conditions = { seats: { N: { hcp: [6, 9] as const, shapes: ['5332'] }, S: { hand: parseHand('AKQ2.K73.9.AJ852')! }, W: { shortest: [0, 1] as const } } }
    expect(conditionsOf(formsOf(conditions))).toEqual(conditions)
  })
})

describe('PracticeDialog: deal sets and saved settings (e10-t16)', () => {
  it('sends a practice set, or the favourites ticked', async () => {
    const onSubmit = open()
    await userEvent.click(screen.getByRole('radio', { name: /從牌組選/ }))
    expect(await screen.findByRole('radio', { name: '範例 · 3 副' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Just Declare/ })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      { deal: 'set', set: { source: 'practice', id: 'sample' }, robotKind: 'gib', justDeclare: false },
      'hidden',
    )
    await userEvent.click(screen.getByRole('radio', { name: '我的收藏' }))
    // Nothing ticked yet: nothing to deal
    await userEvent.click(await screen.findByRole('checkbox', { name: /第 7 副/ }))
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenLastCalledWith(
      { deal: 'set', set: { source: 'favorites', ids: ['b1'] }, robotKind: 'gib', justDeclare: false },
      'hidden',
    )
  })

  it('applies, saves and deletes the member’s own settings', async () => {
    mocks.presets = [{ id: 'x1', name: '1NT 練習', savedAt: 1, settings: { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false, biddingOnly: true, showHands: true } }]
    mocks.save.mockResolvedValue({ presets: [{ ...mocks.presets[0], name: '我的 1NT' }] })
    mocks.remove.mockResolvedValue({ presets: [] })
    const onSubmit = open()
    await userEvent.click(await screen.findByRole('button', { name: '套用「1NT 練習」' }))
    expect(screen.getByRole('radio', { name: /1NT 開叫/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /顯示四家/ })).toBeChecked()
    const name = screen.getByRole('textbox', { name: '設定的名稱' })
    await userEvent.clear(name)
    await userEvent.type(name, '我的 1NT')
    await userEvent.click(screen.getByRole('button', { name: '存成我的設定' }))
    expect(mocks.save).toHaveBeenCalledWith('我的 1NT', { deal: 'oneNotrump', robotKind: 'gib', justDeclare: false, biddingOnly: true, showHands: true })
    expect(await screen.findByText('已存成「我的 1NT」')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '刪除「我的 1NT」' }))
    expect(mocks.remove).toHaveBeenCalledWith('x1')
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith({ deal: 'oneNotrump', robotKind: 'gib', justDeclare: false, biddingOnly: true, showHands: true }, 'hidden')
  })
})

describe('PracticeBanner (e10-t16)', () => {
  it('names the deal set, the problem and 顯示四家', () => {
    wrap(
      <PracticeBanner
        practice={{ deal: 'set', set: { source: 'practice', id: 'sample' }, robotKind: 'gib', justDeclare: false, showHands: true, dealt: 2, problem: { seq: 2, count: 3 } }}
      />,
    )
    expect(screen.getByText('練習牌組 · 第 2／3 題 · TKB（2/1） · 顯示四家')).toBeInTheDocument()
  })
})

const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: 'Robot', robot: true, robotKind: 'gib' as const, online: true })

function practiceTable(board: Partial<BoardView>, practice: Partial<TableView['practice']> = {}): TableView {
  return {
    id: 'p1',
    number: 1,
    hostId: 'amy',
    settings: { access: 'hidden', allowKibitz: true, boardMinutes: 0 },
    seats: { N: robot('N'), E: robot('E'), S: { id: 'amy', username: 'amy', online: true }, W: robot('W') },
    spectators: [],
    mySeat: 'S',
    board: {
      boardNo: 3,
      dealer: 'S',
      vul: 'EW',
      phase: 'auction',
      hands: { N: ['SA', 'SK', 'HA'], E: ['SQ'], S: ['CA', 'CK', 'DA'], W: ['SJ'] },
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
      ...board,
    } as BoardView,
    boardsPlayed: 0,
    dealAt: null,
    chat: [],
    recent: [],
    practice: { deal: 'random', robotKind: 'gib', justDeclare: false, biddingOnly: true, dealt: 1, showHands: true, ...practice },
    boardEndsAt: null,
    waiting: null,
  }
}

const showTable = () =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/table/p1']}>
        <Routes>
          <Route path="/table/:tableId" element={<TablePage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

describe('顯示四家 at the practice table (e10-t16)', () => {
  it('marks the hands shown only for the asking, and turns it off', async () => {
    mocks.table = practiceTable({})
    showTable()
    // North, East and West are marked; South is the member's own
    expect(screen.getAllByText('顯示中')).toHaveLength(3)
    const hide = screen.getByRole('button', { name: '隱藏他家' })
    expect(hide).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(hide)
    expect(mocks.send).toHaveBeenCalledWith({ type: 'showHands', show: false })
  })

  it('offers to show the hands when they are hidden', async () => {
    mocks.table = practiceTable({ hands: { S: ['CA'] } }, { showHands: undefined })
    showTable()
    expect(screen.queryByText('顯示中')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '顯示四家' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'showHands', show: true })
  })

  it('tells what a deal set’s board teaches once the auction is over', () => {
    mocks.table = practiceTable(
      { phase: 'finished', turn: null, legalCalls: [], contract: { level: 3, strain: 'N', doubled: '', declarer: 'S' } },
      { problem: { seq: 1, count: 3, note: '先用 Stayman 找高花配合' } },
    )
    showTable()
    const result = screen.getByRole('status', { name: '叫牌結束' })
    expect(within(result).getByText('教學重點')).toBeInTheDocument()
    expect(within(result).getByText(/先用 Stayman/)).toBeInTheDocument()
    expect(screen.queryByText('顯示中')).toBeNull()
  })
})
