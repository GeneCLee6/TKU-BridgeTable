import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IMPORT_LIMITS, type ImportedBoard } from '../../shared/imports.ts'
import type { PracticeSetChoice } from '../../shared/practice.ts'
import { LinImportDialog } from '../../src/components/LinImportDialog.tsx'
import { PracticeSetPicker } from '../../src/components/PracticeSetPicker.tsx'
import { ApiError } from '../../src/lib/api.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The dialogs that bring in files, in the browser (`e4-t39`, `e10-t09`): parsed here, sent in batches, problems named */

const mocks = vi.hoisted(() => ({
  importBoards: vi.fn(),
  importOwnDeals: vi.fn(),
  removeOwnDeals: vi.fn(),
  ownDeals: vi.fn(),
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: {
    importBoards: mocks.importBoards,
    importOwnDeals: mocks.importOwnDeals,
    removeOwnDeals: mocks.removeOwnDeals,
    ownDeals: mocks.ownDeals,
    practiceSets: () => Promise.resolve({ sets: [{ id: 'sample', count: 3, categories: [] }] }),
  },
}))

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.ownDeals.mockResolvedValue({ deals: [] })
})

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

const lin = (no: number) =>
  `pn|amy,ben,cat,dan|st||md|3SAKQJT98765432,HAKQJT98765432,DAKQJT98765432,|rh||ah|Board ${no}|sv|b|mb|p|mb|p|mb|1N|mb|p|mb|p|mb|p|mc|7|`

const paste = (text: string) => fireEvent.change(screen.getByLabelText('或貼上內容'), { target: { value: text } })

describe('LinImportDialog', () => {
  it('shows what it read and what is wrong, naming the board, before anything is sent', async () => {
    wrap(<LinImportDialog onClose={() => {}} onImported={() => {}} />)
    expect(screen.getByRole('button', { name: '匯入' })).toBeDisabled()
    paste(`${lin(1)}\n${lin(2).replace('mb|1N', 'mb|9Q')}`)
    expect(screen.getByText('可以匯入 1 副')).toBeInTheDocument()
    expect(screen.getByText('1 副有問題，不會匯入：')).toBeInTheDocument()
    expect(screen.getByText('第 2 副：叫牌過程不合規則')).toBeInTheDocument()
    expect(mocks.importBoards).not.toHaveBeenCalled()
  })

  it('says when nothing could be read, without a crash', () => {
    wrap(<LinImportDialog onClose={() => {}} onImported={() => {}} />)
    paste('this is not a LIN at all')
    expect(screen.getByRole('alert')).toHaveTextContent('在這份內容裡找不到牌')
    expect(screen.getByRole('button', { name: '匯入' })).toBeDisabled()
  })

  it('sends batches, with the seat from the name given or else the seat chosen', async () => {
    const onImported = vi.fn()
    mocks.importBoards.mockResolvedValue({ added: 1, duplicates: 0, ids: [] })
    wrap(<LinImportDialog onClose={() => {}} onImported={onImported} />)
    const boards = Array.from({ length: IMPORT_LIMITS.batchBoards + 1 }, (_, i) => lin(i + 1))
    paste(boards.join('\n'))
    await userEvent.type(screen.getByLabelText('你在 BBO 的名字'), 'BEN')
    await userEvent.click(screen.getByRole('button', { name: '匯入' }))
    await waitFor(() => expect(mocks.importBoards).toHaveBeenCalledTimes(2))
    const [first, session] = mocks.importBoards.mock.calls[0] as [ImportedBoard[], string]
    expect(first).toHaveLength(IMPORT_LIMITS.batchBoards)
    expect(first[0].seat).toBe('W')
    expect(mocks.importBoards.mock.calls[1][0]).toHaveLength(1)
    // One import, one session
    expect(mocks.importBoards.mock.calls[1][1]).toBe(session)
    expect(await screen.findByText(/新增 2 副/)).toBeInTheDocument()
    expect(onImported).toHaveBeenCalled()
  })

  it('uses the chosen seat when the name is not there, and shows the server\'s refusal', async () => {
    mocks.importBoards.mockRejectedValue(new ApiError('x', 400, 'importsFull', { max: 1000 }))
    wrap(<LinImportDialog onClose={() => {}} onImported={() => {}} />)
    paste(lin(1))
    await userEvent.selectOptions(screen.getByLabelText('對不上時我坐'), '東')
    await userEvent.click(screen.getByRole('button', { name: '匯入' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('匯入的紀錄最多 1000 副')
    expect((mocks.importBoards.mock.calls[0][0] as ImportedBoard[])[0].seat).toBe('E')
  })

  it('refuses too many boards in a file', () => {
    wrap(<LinImportDialog onClose={() => {}} onImported={() => {}} />)
    paste(Array.from({ length: IMPORT_LIMITS.linBoards + 1 }, (_, i) => lin(i + 1)).join(''))
    expect(screen.getByRole('alert')).toHaveTextContent(`一次最多匯入 ${IMPORT_LIMITS.linBoards} 副`)
    expect(screen.getByRole('button', { name: '匯入' })).toBeDisabled()
  })

  it('reads a file, and refuses one that is too large', async () => {
    wrap(<LinImportDialog onClose={() => {}} onImported={() => {}} />)
    const input = screen.getByLabelText('選擇檔案')
    const big = new File(['x'], 'big.lin')
    Object.defineProperty(big, 'size', { value: IMPORT_LIMITS.fileBytes + 1 })
    await userEvent.upload(input, big)
    expect(await screen.findByRole('alert')).toHaveTextContent('檔案太大，最多 1 MB')
    const file = new File([lin(1)], 'one.lin', { type: 'text/plain' })
    await userEvent.upload(input, file)
    expect(await screen.findByText('可以匯入 1 副')).toBeInTheDocument()
  })
})

describe('PracticeSetPicker: my deals', () => {
  const DEAL = 'N:AKQJ.AKQ.AKQ.AKQ T987.JT9.JT9.JT9 6543.876.876.876 2.5432.5432.5432'
  const info = (id: string, boardNo: number, title?: string) => ({ id, boardNo, dealer: 'N', vul: 'None', addedAt: 1, ...(title && { title }) })

  function Picker({ onChange = vi.fn(), value }: { onChange?: (set: PracticeSetChoice | undefined) => void; value?: PracticeSetChoice }) {
    return <PracticeSetPicker value={value ?? { source: 'mine', ids: ['d1'] }} onChange={onChange} />
  }

  it('imports PBN into the list, naming a board that is wrong', async () => {
    mocks.importOwnDeals.mockResolvedValue({ added: 1, duplicates: 1, deals: [info('d2', 7, 'Set A')] })
    wrap(<Picker />)
    await screen.findByText('還沒有牌，用下面的 PBN 匯入')
    paste(`[Board "7"]\n[Event "Set A"]\n[Deal "${DEAL}"]\n[Board "8"]\n[Deal "N:AKQ"]\n`)
    expect(screen.getByText('第 8 副：牌不對，四家要剛好是 52 張不同的牌')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '加入我的牌組' }))
    await waitFor(() => expect(mocks.importOwnDeals).toHaveBeenCalled())
    expect(mocks.importOwnDeals.mock.calls[0][0]).toMatchObject([{ boardNo: 7, hands: DEAL, title: 'Set A' }])
    expect(await screen.findByText('加入 1 副，1 副已經在牌組裡')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Set A/ })).toBeInTheDocument()
  })

  it('lists the deals to tick and removes the ticked ones', async () => {
    mocks.ownDeals.mockResolvedValue({ deals: [info('d1', 1, 'Set A'), info('d2', 2)] })
    mocks.removeOwnDeals.mockResolvedValue({ deals: [info('d2', 2)] })
    const onChange = vi.fn()
    wrap(<Picker onChange={onChange} />)
    expect(await screen.findByRole('checkbox', { name: /Set A/ })).toBeChecked()
    await userEvent.click(screen.getByRole('checkbox', { name: /第 2 副|2/ }))
    expect(onChange).toHaveBeenCalledWith({ source: 'mine', ids: ['d1', 'd2'] })
    await userEvent.click(screen.getByRole('button', { name: '刪除勾選的牌' }))
    await waitFor(() => expect(mocks.removeOwnDeals).toHaveBeenCalledWith(['d1']))
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Set A/ })).not.toBeInTheDocument())
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })
})
