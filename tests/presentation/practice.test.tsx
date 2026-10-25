import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { bookTopics } from '../../shared/book-topics.ts'
import type { AuctionCall } from '../../shared/auction.ts'
import { ROBOT_SYSTEMS } from '../../shared/robot/robots.ts'
import { BookHints } from '../../src/components/BookHints.tsx'
import { PracticeBanner } from '../../src/components/PracticeBanner.tsx'
import { PracticeDialog } from '../../src/components/PracticeDialog.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import type { BoardView } from '../../shared/protocol.ts'

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('PracticeDialog (e10-t04)', () => {
  it('opens with any deal and TKB in the club’s system, and sends a preset with the robots and Just Declare', async () => {
    const onSubmit = vi.fn()
    wrap(<PracticeDialog onSubmit={onSubmit} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '和機器人練習' })
    expect(within(dialog).getByRole('radio', { name: /隨機/ })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: 'TKB（淡江制度）' })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('radio', { name: /1NT 開叫/ }))
    await userEvent.click(within(dialog).getByRole('radio', { name: 'TKB（2/1）' }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /Just Declare/ }))
    // Who may watch: hidden (only the invited) unless the member opens it up
    expect(within(dialog).getByRole('group', { name: '誰可以觀看' })).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: /隱藏/ })).toBeChecked()
    await userEvent.click(within(dialog).getByRole('radio', { name: /申請加入/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith({ deal: 'oneNotrump', robotKind: 'gib', justDeclare: true }, 'request')
  })

  it('sends only the conditions the member narrowed', async () => {
    const onSubmit = vi.fn()
    wrap(<PracticeDialog onSubmit={onSubmit} onClose={() => {}} />)
    await userEvent.click(screen.getByRole('radio', { name: /自訂條件/ }))
    const southTo = screen.getAllByRole('spinbutton', { name: '點力 最多' })[0]
    await userEvent.clear(southTo)
    await userEvent.type(southTo, '14')
    const spadesFrom = screen.getByRole('spinbutton', { name: '♠ 張數 最少' })
    await userEvent.clear(spadesFrom)
    await userEvent.type(spadesFrom, '5')
    await userEvent.click(screen.getAllByRole('checkbox', { name: '平均牌型' })[1])
    await userEvent.click(screen.getByRole('button', { name: '開始練習' }))
    expect(onSubmit).toHaveBeenCalledWith({
      deal: 'custom',
      robotKind: 'tku',
      justDeclare: false,
      conditions: { seats: { S: { hcp: [12, 14], lengths: { S: [5, 13] } }, N: { balanced: true } } },
    }, 'hidden')
  })
})

describe('PracticeBanner', () => {
  it('names the board and how the table deals', () => {
    wrap(<PracticeBanner practice={{ deal: 'slam', robotKind: 'tku', justDeclare: true, dealt: 4 }} />)
    expect(screen.getByText('練習 · 第 4 副')).toBeInTheDocument()
    expect(screen.getByText('滿貫牌 · TKB（淡江制度） · 只打莊（Just Declare）')).toBeInTheDocument()
  })
})

const call = (seat: AuctionCall['seat'], made: string): AuctionCall => ({ seat, call: made })

describe('the bidding hint card (e10-t06)', () => {
  it('gives the opening’s page and the conventions made and to come', () => {
    const topics = bookTopics(ROBOT_SYSTEMS.tku, [call('N', '1N'), call('E', 'P')], 'N', 'None', 'NS')
    expect(topics.soFar).toEqual([{ slug: 'system-notrump', kind: 'opening', call: '1N' }])
    // South could bid Stayman or a transfer next: both on the 1NT responses page
    const responses = topics.next.find((t) => t.slug === 'notrump-responses')
    expect(responses?.kind === 'convention' && responses.conventions).toEqual(expect.arrayContaining(['stayman', 'transfer']))
  })

  it('points to the competition page when the opponents opened, and lists nothing to come once the auction is over', () => {
    const auction = [call('E', '1H'), call('S', 'P'), call('W', 'P'), call('N', 'P')]
    const topics = bookTopics(ROBOT_SYSTEMS.tku, auction, 'E', 'None', 'NS', true)
    expect(topics.soFar).toEqual([{ slug: 'system-competition', kind: 'competition' }])
    expect(topics.next).toEqual([])
  })

  it('renders the server’s pages, opening the book in a new tab, and says the book is the club’s system at a 2/1 table', async () => {
    const auction = [call('N', '1N')]
    const board = { auction, dealer: 'N', vul: 'None', phase: 'auction', bookTopics: bookTopics(ROBOT_SYSTEMS.tku, auction, 'N', 'None', 'NS') } as unknown as BoardView
    const { unmount } = wrap(<BookHints board={board} robotKind="tku" />)
    const link = await screen.findByRole('link', { name: /1NT 開叫與答叫/ })
    expect(link).toHaveAttribute('href', 'https://tku-bridge-book.vercel.app/c/system-notrump')
    expect(link).toHaveAttribute('target', '_blank')
    unmount()
    wrap(<BookHints board={board} robotKind="gib" />)
    expect(screen.getByText(/2\/1 制度/)).toBeInTheDocument()
  })

  it('lists nothing without the server’s pages: the browser never runs the engine', async () => {
    const board = { auction: [call('N', '1N')], dealer: 'N', vul: 'None', phase: 'auction' } as unknown as BoardView
    wrap(<BookHints board={board} robotKind="tku" />)
    expect(await screen.findByText(/叫牌開始後/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /1NT 開叫與答叫/ })).toBeNull()
  })
})
