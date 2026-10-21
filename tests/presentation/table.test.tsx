import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { legalCalls } from '../../shared/auction.ts'
import { AuctionBox } from '../../src/components/AuctionBox.tsx'
import { BiddingBox } from '../../src/components/BiddingBox.tsx'
import { HandView } from '../../src/components/HandView.tsx'
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
    wrap(<HandView cards={['SA', 'SK', 'H2']} count={3} playable={['SA', 'SK']} onPlay={onPlay} label="S" />)
    expect(screen.getByRole('button', { name: '紅心2' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '黑桃K' }))
    expect(onPlay).toHaveBeenCalledWith('SK')
  })

  it('shows card backs for a hidden hand', () => {
    wrap(<HandView count={13} label="N" />)
    expect(screen.getByRole('group', { name: 'N' }).children).toHaveLength(13)
  })
})
