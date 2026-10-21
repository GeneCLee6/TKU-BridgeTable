import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { legalCalls } from '../../shared/auction.ts'
import { AuctionBox } from '../../src/components/AuctionBox.tsx'
import { BiddingBox } from '../../src/components/BiddingBox.tsx'
import { HandView } from '../../src/components/HandView.tsx'
import { SeatPlate } from '../../src/components/SeatPlate.tsx'
import { MemoryRouter } from 'react-router-dom'
import { SidePanel } from '../../src/components/SidePanel.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { ClubProvider } from '../../src/state/ClubContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('BiddingBox', () => {
  it('bids a level then a strain, and only offers legal calls', async () => {
    const onCall = vi.fn()
    // After 1♥ by the opponent: 1♥ and lower are gone, X is possible, XX is not
    const legal = [...legalCalls([{ seat: 'N', call: '1H' }], 'N')]
    wrap(<BiddingBox legal={legal} onCall={onCall} />)
    const box = screen.getByRole('group', { name: '叫牌盒' })

    expect(within(box).getByRole('button', { name: 'XX' })).toBeDisabled()
    expect(within(box).getByRole('button', { name: 'X' })).toBeEnabled()

    await userEvent.click(within(box).getByRole('button', { name: '1' }))
    expect(within(box).getByRole('button', { name: '紅心' })).toBeDisabled()
    await userEvent.click(within(box).getByRole('button', { name: '黑桃' }))
    expect(onCall).toHaveBeenCalledWith('1S', undefined)
  })

  it('attaches an alert explanation', async () => {
    const onCall = vi.fn()
    wrap(<BiddingBox legal={[...legalCalls([], 'N')]} onCall={onCall} />)
    await userEvent.click(screen.getByRole('button', { name: 'Alert' }))
    await userEvent.type(screen.getByRole('textbox'), '15-17')
    await userEvent.click(screen.getByRole('button', { name: '1' }))
    await userEvent.click(screen.getByRole('button', { name: 'NT' }))
    expect(onCall).toHaveBeenCalledWith('1N', '15-17')
  })
})

describe('AuctionBox', () => {
  it('starts in the dealer’s column and marks the next seat', () => {
    wrap(
      <AuctionBox
        auction={[
          { seat: 'E', call: '1C', alert: '2+' },
          { seat: 'S', call: 'P' },
        ]}
        dealer="E"
        vul="EW"
        turn="W"
      />,
    )
    const rows = screen.getAllByRole('row')
    const cells = within(rows[1]).getAllByRole('cell')
    // W N E S: West and North are empty, East opened, South passed
    expect(cells.map((c) => c.textContent)).toEqual(['', '', '1♣（Alert：2+）', 'Pass'])
    expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('?')
  })
})

describe('HandView', () => {
  it('lets only legal cards be played', async () => {
    const onPlay = vi.fn()
    wrap(<HandView cards={['SA', 'SK', 'H2']} count={3} width={60} playable={['SA', 'SK']} onPlay={onPlay} label="S" />)
    expect(screen.getByRole('button', { name: '紅心2' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '黑桃K' }))
    expect(onPlay).toHaveBeenCalledWith('SK')
  })

  it('shows card backs for a hidden hand', () => {
    wrap(<HandView count={13} width={60} label="N" />)
    expect(screen.getByRole('group', { name: 'N' }).children).toHaveLength(13)
  })
})

describe('viewer perspective and robots', () => {
  it('turns the auction so the viewer is the last column', () => {
    wrap(<AuctionBox auction={[{ seat: 'N', call: '1C' }]} dealer="N" vul="None" viewer="E" />)
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(heads).toEqual(['S', 'W', 'N', 'E'])
  })

  it('offers sit and add-robot on an empty seat, and remove on a robot', async () => {
    const onAddRobot = vi.fn()
    const onRemoveRobot = vi.fn()
    const { rerender } = wrap(
      <SeatPlate seat="N" occupant={null} vulnerable={false} turn={false} isMe={false} onSit={() => {}} onAddRobot={onAddRobot} />,
    )
    await userEvent.click(screen.getByRole('button', { name: '放機器人 N' }))
    expect(onAddRobot).toHaveBeenCalled()
    rerender(
      <PreferencesProvider>
        <SeatPlate
          seat="N"
          occupant={{ id: 'robot:N', username: 'Robot', robot: true, online: true }}
          vulnerable={false}
          turn={false}
          isMe={false}
          onRemoveRobot={onRemoveRobot}
        />
      </PreferencesProvider>,
    )
    expect(screen.getByText('機器人')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '移除機器人 N' }))
    expect(onRemoveRobot).toHaveBeenCalled()
  })

  it('speaks English when the viewer chooses it', () => {
    window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'en' }))
    wrap(<BiddingBox legal={['P']} onCall={() => {}} />)
    expect(screen.getByRole('group', { name: 'Bidding box' })).toBeInTheDocument()
    wrap(<HandView cards={['SA']} count={1} width={60} label="S" />)
    expect(screen.getByRole('button', { name: 'A of spades' })).toBeInTheDocument()
  })
})

describe('long auctions and the dock', () => {
  it('scrolls a long auction inside the table instead of growing it', () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({ seat: (['N', 'E', 'S', 'W'] as const)[i % 4], call: 'P' }))
    wrap(<AuctionBox auction={calls} dealer="N" vul="None" size={80} maxRows={5} />)
    const scroller = screen.getByRole('table', { name: '叫牌過程' }).parentElement!
    const style = getComputedStyle(scroller)
    expect(style.overflowY).toBe('auto')
    expect(parseInt(style.maxHeight)).toBeGreaterThan(0)
    // The dealer's column starts one cell in, so 40 calls take 11 rounds, plus the header
    expect(screen.getAllByRole('row')).toHaveLength(12)
  })

  it('opens a tab from the strip and closes it again', async () => {
    render(
      <PreferencesProvider>
        <AuthProvider>
          <ClubProvider>
            <MemoryRouter>
              <SidePanel tabs={['chat', 'people', 'history']} page="test" chat={<p>hello</p>} />
            </MemoryRouter>
          </ClubProvider>
        </AuthProvider>
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('tabpanel')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: '聊天' }))
    expect(screen.getByRole('tabpanel', { name: '聊天' })).toHaveTextContent('hello')
    await userEvent.click(screen.getByRole('tab', { name: '社員' }))
    expect(screen.getByRole('tabpanel', { name: '社員' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: '社員' }))
    expect(screen.queryByRole('tabpanel')).toBeNull()
  })
})
