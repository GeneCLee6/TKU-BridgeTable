import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardView, LobbyView, TableTeach, TableView } from '../../shared/protocol.ts'
import { TeachDialog } from '../../src/components/TeachDialog.tsx'
import { TablePage } from '../../src/pages/TablePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/**
 * The teaching table in the browser (`e10-t10`, `e10-t11`): the teacher's buttons and marking tools,
 * and what a student gets of them. What is sent to whom is the server's (tests/worker/teaching-table.test.ts)
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  table: null as TableView | null,
  user: { id: 'tia', username: 'tia', admin: false, permissions: ['teach'] as string[] },
  searchHistory: vi.fn(),
}))

const lobby: LobbyView = { online: [], members: [], tables: [], myTableId: 't1', friends: [], blocked: [] }

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: {
    challenges: () => Promise.resolve({ challenges: [] }),
    practiceSets: () => Promise.resolve({ sets: [{ id: 'sample', count: 3, categories: ['notrump'] }] }),
    searchHistory: mocks.searchHistory,
  },
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  useClub: () => ({ lobby, send: mocks.send, notifications: null, status: 'open', table: mocks.table, error: null }),
  useLobby: () => lobby,
}))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  useAuth: () => ({ user: mocks.user }),
  useFeature: () => false,
}))

beforeEach(() => {
  mocks.send.mockReset()
  mocks.user = { id: 'tia', username: 'tia', admin: false, permissions: ['teach'] }
  mocks.searchHistory.mockReset()
  mocks.searchHistory.mockResolvedValue({
    boards: [
      { id: 'r1', boardNo: 7, finishedAt: Date.UTC(2026, 9, 20) },
      // Kept back: a table would refuse it, so it is not offered
      { id: 'r2', boardNo: 8, finishedAt: Date.UTC(2026, 9, 21), revealAt: Date.now() + 60_000 },
    ],
    total: 2,
    page: 1,
    size: 50,
  })
})

const person = (id: string) => ({ id, username: id, online: true })

function teachTable(teach: Partial<TableTeach> = {}, view: Partial<TableView> = {}, board: Partial<BoardView> = {}): TableView {
  return {
    id: 't1',
    number: 4,
    hostId: 'tia',
    settings: { access: 'hidden', allowKibitz: true, boardMinutes: 0 },
    seats: { N: person('ann'), E: person('bob'), S: person('sam'), W: person('wil') },
    spectators: [{ id: 'tia', username: 'tia' }],
    mySeat: null,
    board: {
      boardNo: 3,
      dealer: 'S',
      vul: 'EW',
      phase: 'auction',
      hands: { N: ['SA', 'SK'], E: ['SQ'], S: ['CA', 'CK'], W: ['SJ'] },
      handCounts: { N: 13, E: 13, S: 13, W: 13 },
      auction: [],
      contract: null,
      dummy: null,
      turn: 'S',
      tricks: [],
      tricksWon: { NS: 0, EW: 0 },
      legalCards: [],
      legalCalls: [],
      canUndo: false,
      canClaim: false,
      ...board,
    } as BoardView,
    boardsPlayed: 0,
    dealAt: null,
    chat: [],
    recent: [],
    teach: { paused: false, marks: [], openHands: false, canUndo: true, ...teach },
    boardEndsAt: null,
    waiting: null,
    robotSpeed: 'fast',
    ...view,
  } as TableView
}

const showTable = (table: TableView) => {
  mocks.table = table
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={['/table/t1']}>
        <Routes>
          <Route path="/table/:tableId" element={<TablePage />} />
          <Route path="/" element={<p>lobby</p>} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

const asStudent = () => {
  mocks.user = { id: 'sam', username: 'sam', admin: false, permissions: [] }
}

describe('the teacher’s buttons (e10-t10)', () => {
  it('names the table and which of the chosen deals is on it, and marks the hands seen only as the teacher', () => {
    showTable(teachTable({ problem: { seq: 2, count: 5, title: 'Lesson' } }))
    expect(screen.getByText('教學桌 4')).toBeInTheDocument()
    expect(screen.getByText(/Lesson/)).toBeInTheDocument()
    expect(screen.getAllByText('顯示中')).toHaveLength(4)
    expect(screen.queryByText('觀看中')).not.toBeInTheDocument()
  })

  it('asks the server for undo, replay, the next board and who sees the hands', async () => {
    showTable(teachTable())
    await userEvent.click(screen.getByRole('button', { name: '撤回一步' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'teachUndo' })
    await userEvent.click(screen.getByRole('button', { name: '重打這一副' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'teachReplay' })
    await userEvent.click(screen.getByRole('button', { name: '下一副' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'redeal' })
    await userEvent.click(screen.getByRole('button', { name: '讓旁聽看四家' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'showHands', show: true })
    await userEvent.click(screen.getByRole('button', { name: '暫停講解' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'teachPause', paused: true })
  })

  it('has nothing to undo when the server says so, and only a deal to ask for before the first board', () => {
    const { unmount } = showTable(teachTable({ canUndo: false }))
    expect(screen.getByRole('button', { name: '撤回一步' })).toBeDisabled()
    unmount()
    showTable(teachTable({}, { board: null }))
    expect(screen.getByRole('button', { name: '發牌' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '暫停講解' })).not.toBeInTheDocument()
  })

  it('gives a student none of them, not even the undo of an ordinary table', () => {
    asStudent()
    showTable(teachTable({ canUndo: undefined }, { mySeat: 'S' }, { hands: { S: ['CA'] } }))
    for (const name of ['暫停講解', '撤回一步', '重打這一副', '下一副', '撤回']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByText('顯示中')).not.toBeInTheDocument()
  })
})

describe('marking (e10-t11)', () => {
  const tools = () => within(screen.getByRole('form', { name: '標示工具' }))

  it('has its tools only while paused', () => {
    showTable(teachTable())
    expect(screen.queryByRole('form', { name: '標示工具' })).not.toBeInTheDocument()
  })

  it('circles the card clicked instead of playing it', async () => {
    showTable(teachTable({ paused: true }))
    await userEvent.click(screen.getByRole('button', { name: '黑桃A' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'teachMark', mark: { kind: 'circle', card: 'SA' } })
    expect(mocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'play' }))
  })

  it('draws an arrow from a seat to a card, one end at a time', async () => {
    showTable(teachTable({ paused: true }))
    await userEvent.click(tools().getByRole('button', { name: '箭頭' }))
    await userEvent.click(tools().getByRole('button', { name: '北' }))
    expect(mocks.send).not.toHaveBeenCalled()
    expect(tools().getByRole('status')).toHaveTextContent('終點')
    await userEvent.click(screen.getByRole('button', { name: '梅花A' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'teachMark', mark: { kind: 'arrow', from: { seat: 'N' }, to: { card: 'CA' } } })
  })

  it('adds a short text, warning that everyone reads it', async () => {
    showTable(teachTable({ paused: true }))
    await userEvent.click(tools().getByRole('button', { name: '文字' }))
    expect(tools().getByRole('status')).toHaveTextContent('每位學生都看得到')
    expect(tools().getByRole('button', { name: '加上' })).toBeDisabled()
    await userEvent.type(tools().getByRole('textbox', { name: '簡短的說明' }), ' 看這裡 ')
    await userEvent.selectOptions(tools().getByRole('combobox', { name: '放在哪裡' }), '東')
    await userEvent.click(tools().getByRole('button', { name: '加上' }))
    expect(mocks.send).toHaveBeenCalledWith({ type: 'teachMark', mark: { kind: 'text', text: '看這裡', seat: 'E' } })
    expect(tools().getByRole('textbox', { name: '簡短的說明' })).toHaveValue('')
  })

  it('clears the marks, and going on is one button', async () => {
    showTable(teachTable({ paused: true, marks: [{ id: 1, kind: 'text', text: 'a' }] }))
    await userEvent.click(tools().getByRole('button', { name: '清除標示' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'teachUnmark' })
    await userEvent.click(screen.getByRole('button', { name: '繼續' }))
    expect(mocks.send).toHaveBeenLastCalledWith({ type: 'teachPause', paused: false })
  })

  it('shows a student the marks the server sent and that the table is paused; nothing there is clickable', async () => {
    asStudent()
    const { container } = showTable(
      teachTable(
        {
          paused: true,
          canUndo: undefined,
          marks: [
            { id: 0, kind: 'circle', card: 'CA' },
            { id: 1, kind: 'arrow', from: { seat: 'N' }, to: { card: 'CA' } },
            { id: 2, kind: 'text', text: '看這裡' },
          ],
        },
        { mySeat: 'S' },
        { hands: { S: ['CA'] } },
      ),
    )
    expect(screen.getByText('老師暫停講解中')).toBeInTheDocument()
    expect(screen.getByText('看這裡')).toBeInTheDocument()
    expect(container.querySelectorAll('ellipse')).toHaveLength(1)
    expect(container.querySelectorAll('svg line')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: '梅花A' }))
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('leaves out a mark on a card that is not on the page', () => {
    asStudent()
    const { container } = showTable(teachTable({ paused: true, marks: [{ id: 0, kind: 'circle', card: 'HA' }] }, { mySeat: 'S' }, { hands: { S: ['CA'] } }))
    expect(container.querySelectorAll('ellipse')).toHaveLength(0)
  })
})

describe('opening a teaching table', () => {
  const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

  it('opens with any deal, hidden unless chosen', async () => {
    const onSubmit = vi.fn()
    wrap(<TeachDialog onClose={() => {}} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('button', { name: '開桌' }))
    expect(onSubmit).toHaveBeenCalledWith(undefined, 'hidden')
  })

  it('chooses records the teacher may read, public ones only, or one by its address', async () => {
    const onSubmit = vi.fn()
    wrap(<TeachDialog onClose={() => {}} onSubmit={onSubmit} />)
    await userEvent.click(screen.getByRole('radio', { name: /指定牌組/ }))
    await userEvent.click(screen.getByRole('radio', { name: '紀錄' }))
    expect(screen.getByRole('button', { name: '開桌' })).toBeDisabled()
    expect(mocks.searchHistory).toHaveBeenCalledWith({ scope: 'all', size: 50 })
    await userEvent.click(await screen.findByRole('checkbox', { name: /第 7 副/ }))
    expect(screen.queryByRole('checkbox', { name: /第 8 副/ })).not.toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: '紀錄的網址或編號' }), 'https://x.test/history/abc123')
    await userEvent.click(screen.getByRole('button', { name: '加入' }))
    await userEvent.click(screen.getByRole('button', { name: '開桌' }))
    expect(onSubmit).toHaveBeenCalledWith({ source: 'records', ids: ['r1', 'abc123'] }, 'hidden')
  })
})
