import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { TableSettingsDialog } from '../../src/components/TableSettingsDialog.tsx'
import { useCardChoice } from '../../src/lib/useCardChoice.ts'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { ClubProvider } from '../../src/state/ClubContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('TableSettingsDialog', () => {
  it('opens public with watching allowed, and sends what the host chose', async () => {
    const onSubmit = vi.fn()
    wrap(<TableSettingsDialog title="開新桌" submitLabel="開桌" onSubmit={onSubmit} onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '開新桌' })
    expect(within(dialog).getByRole('radio', { name: /公開/ })).toBeChecked()
    expect(within(dialog).getByRole('checkbox', { name: /允許觀看/ })).toBeChecked()

    await userEvent.click(within(dialog).getByRole('radio', { name: /只限受邀/ }))
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /允許觀看/ }))
    await userEvent.click(within(dialog).getByRole('button', { name: '開桌' }))
    expect(onSubmit).toHaveBeenCalledWith({ visibility: 'invite', allowKibitz: false, boardMinutes: 0 }, [])
  })

  it('lists the members to invite at an invite table, and sets a time limit per board', async () => {
    const onSubmit = vi.fn()
    const members = [
      { id: 'a1', username: 'amy' },
      { id: 'b2', username: 'bob' },
    ]
    wrap(
      <TableSettingsDialog title="開新桌" submitLabel="開桌" members={members} onSubmit={onSubmit} onClose={() => {}} />,
    )
    // A public table asks nobody
    expect(screen.queryByRole('checkbox', { name: 'amy' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: /只限受邀/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'bob' }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '每副時間上限' }), '7')
    await userEvent.click(screen.getByRole('button', { name: '開桌' }))
    expect(onSubmit).toHaveBeenCalledWith({ visibility: 'invite', allowKibitz: true, boardMinutes: 7 }, ['b2'])
  })

  it('starts from the table’s settings and closes with Escape', async () => {
    const onClose = vi.fn()
    wrap(
      <TableSettingsDialog
        title="牌桌設定"
        submitLabel="儲存"
        initial={{ visibility: 'invite', allowKibitz: false, boardMinutes: 0 }}
        onSubmit={() => {}}
        onClose={onClose}
      />,
    )
    expect(screen.getByRole('radio', { name: /只限受邀/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /允許觀看/ })).not.toBeChecked()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

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

  describe('with a 2/1 robot partner', () => {
    const hints = {
      title: 'TKB（2/1）的理解',
      text: (call: string) => ({ P: '0–5 大牌點', '1S': '4+ 張♠，6+ 大牌點，迫叫一圈', X: '負性賭倍' })[call] ?? '機器人沒有特別的理解',
    }
    const legal = [...legalCalls([{ seat: 'N', call: '1C' }, { seat: 'E', call: '1D' }], 'N')]

    it('shows how the robot reads a call under the mouse, without making it', async () => {
      const onCall = vi.fn()
      wrap(<BiddingBox legal={legal} onCall={onCall} hints={hints} />)
      await userEvent.hover(screen.getByRole('button', { name: 'Pass' }))
      expect(screen.getByRole('status')).toHaveTextContent('TKB（2/1）的理解0–5 大牌點')
      await userEvent.click(screen.getByRole('button', { name: '1' }))
      await userEvent.hover(screen.getByRole('button', { name: '黑桃' }))
      expect(screen.getByRole('status')).toHaveTextContent('4+ 張♠，6+ 大牌點，迫叫一圈')
      await userEvent.hover(screen.getByRole('button', { name: '紅心' }))
      expect(screen.getByRole('status')).toHaveTextContent('機器人沒有特別的理解')
      expect(onCall).not.toHaveBeenCalled()
    })

    it('shows it on keyboard focus too', async () => {
      wrap(<BiddingBox legal={legal} onCall={vi.fn()} hints={hints} />)
      screen.getByRole('button', { name: 'X' }).focus()
      expect(await screen.findByRole('status')).toHaveTextContent('負性賭倍')
    })

    it('shows it on a long press on a phone, and that press makes no call', async () => {
      vi.useFakeTimers()
      try {
        const onCall = vi.fn()
        wrap(<BiddingBox legal={legal} onCall={onCall} hints={hints} />)
        const pass = screen.getByRole('button', { name: 'Pass' })
        fireEvent.pointerDown(pass, { pointerType: 'touch' })
        act(() => void vi.advanceTimersByTime(500))
        fireEvent.pointerUp(pass, { pointerType: 'touch' })
        fireEvent.click(pass)
        expect(screen.getByRole('status')).toHaveTextContent('0–5 大牌點')
        expect(onCall).not.toHaveBeenCalled()
        // A quick tap still makes the call
        fireEvent.pointerDown(pass, { pointerType: 'touch' })
        fireEvent.pointerUp(pass, { pointerType: 'touch' })
        fireEvent.click(pass)
        expect(onCall).toHaveBeenCalledWith('P', undefined)
      } finally {
        vi.useRealTimers()
      }
    })

    it('shows nothing without hints', async () => {
      wrap(<BiddingBox legal={legal} onCall={vi.fn()} />)
      await userEvent.hover(screen.getByRole('button', { name: 'Pass' }))
      expect(screen.queryByRole('status')).toBeNull()
    })
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

  it('with confirmation on, waits for the confirm button before making the call', async () => {
    const onCall = vi.fn()
    wrap(<BiddingBox legal={[...legalCalls([], 'N')]} onCall={onCall} confirm />)
    await userEvent.click(screen.getByRole('button', { name: '1' }))
    await userEvent.click(screen.getByRole('button', { name: '黑桃' }))
    expect(onCall).not.toHaveBeenCalled()
    const bar = screen.getByRole('group', { name: '確定' })
    // Changing the mind: cancel, then choose Pass and confirm it
    await userEvent.click(within(bar).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group', { name: '確定' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Pass' }))
    await userEvent.click(within(screen.getByRole('group', { name: '確定' })).getByRole('button', { name: '確定' }))
    expect(onCall).toHaveBeenCalledWith('P', undefined)
  })

  it('bids from the keyboard: a level, a strain, then Enter', async () => {
    const onCall = vi.fn()
    // After 1♥: 1♠ is legal, 1♣ is not; X is legal
    wrap(<BiddingBox legal={[...legalCalls([{ seat: 'N', call: '1H' }], 'N')]} onCall={onCall} />)
    await userEvent.keyboard('1c')
    expect(screen.queryByRole('group', { name: '確定' })).toBeNull()
    await userEvent.keyboard('s')
    expect(screen.getByRole('group', { name: '確定' })).toHaveTextContent('1♠')
    expect(onCall).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onCall).toHaveBeenCalledWith('1S', undefined)
  })

  it('takes P and X from the keyboard, Escape cancels, and typing an alert is left alone', async () => {
    const onCall = vi.fn()
    wrap(<BiddingBox legal={[...legalCalls([{ seat: 'N', call: '1H' }], 'N')]} onCall={onCall} />)
    await userEvent.keyboard('x{Escape}{Enter}')
    expect(onCall).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Alert' }))
    await userEvent.type(screen.getByRole('textbox'), 'px')
    expect(screen.queryByRole('group', { name: '確定' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'X' }))
    expect(onCall).toHaveBeenCalledWith('X', 'px')
    await userEvent.keyboard('p{Enter}')
    expect(onCall).toHaveBeenLastCalledWith('P', undefined)
  })

  it('prints the keys on the box for keyboard users, hidden from the key names', () => {
    wrap(<BiddingBox legal={[...legalCalls([], 'N')]} onCall={() => {}} />)
    const box = screen.getByRole('group', { name: '叫牌盒' })
    expect(box).toHaveAccessibleDescription(/Enter/)
    expect(within(box).getByRole('button', { name: 'Pass' })).toHaveAttribute('aria-keyshortcuts', 'P')
  })
})

describe('choosing a card (confirm cards, keyboard play)', () => {
  function Hand({ confirm, onPlay }: { confirm: boolean; onPlay: (card: string) => void }) {
    const playable = ['SA', 'SK', 'H2']
    const { chosen, pick } = useCardChoice({ cards: playable, confirm, turn: '1:0', onPlay })
    return <HandView cards={['SA', 'SK', 'H2', 'D3']} count={4} width={60} playable={playable} chosen={chosen} onPlay={pick} label="S" />
  }

  it('lifts the card on the first click and plays it on the second', async () => {
    const onPlay = vi.fn()
    wrap(<Hand confirm onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: '黑桃K' }))
    expect(onPlay).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '黑桃K' })).toHaveAttribute('aria-current', 'true')
    // Another card takes its place
    await userEvent.click(screen.getByRole('button', { name: '紅心2' }))
    expect(screen.getByRole('button', { name: '黑桃K' })).not.toHaveAttribute('aria-current')
    await userEvent.click(screen.getByRole('button', { name: '紅心2' }))
    expect(onPlay).toHaveBeenCalledWith('H2')
  })

  it('plays at once without confirmation', async () => {
    const onPlay = vi.fn()
    wrap(<Hand confirm={false} onPlay={onPlay} />)
    await userEvent.click(screen.getByRole('button', { name: '黑桃A' }))
    expect(onPlay).toHaveBeenCalledWith('SA')
  })

  it('moves between the legal cards with the arrow keys and plays with Enter', async () => {
    const onPlay = vi.fn()
    wrap(<Hand confirm={false} onPlay={onPlay} />)
    expect(screen.getByRole('group', { name: 'S' })).toHaveAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Enter')
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('button', { name: '黑桃A' })).toHaveAttribute('aria-current', 'true')
    // ♦3 cannot be played: from ♥2 the arrow wraps round to ♠A
    await userEvent.keyboard('{ArrowRight}{ArrowRight}')
    expect(screen.getByRole('button', { name: '紅心2' })).toHaveAttribute('aria-current', 'true')
    await userEvent.keyboard('{ArrowRight}{ArrowLeft}')
    expect(screen.getByRole('button', { name: '紅心2' })).toHaveAttribute('aria-current', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onPlay).toHaveBeenCalledWith('H2')
    expect(onPlay).toHaveBeenCalledTimes(1)
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
    expect(cells.map((c) => c.textContent)).toEqual(['', '', '1♣（Alert）', 'Pass'])
    expect(within(rows[2]).getAllByRole('cell')[0]).toHaveTextContent('?')
  })

  it('opens an alerted call’s explanation in a small window, and closes it', async () => {
    wrap(<AuctionBox auction={[{ seat: 'E', call: '1C', alert: '2+ 張♣，12–21 點' }]} dealer="E" vul="None" names={{ E: 'Robot' }} />)
    await userEvent.click(screen.getByRole('button', { name: /Alert/ }))
    const popup = screen.getByRole('dialog', { name: 'Alert' })
    expect(popup).toHaveTextContent('2+ 張♣，12–21 點')
    expect(popup).toHaveTextContent('E Robot')
    await userEvent.click(within(popup).getByRole('button', { name: '關閉' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('explains a 2/1 robot’s call from what it shows, in the viewer’s language', async () => {
    const meaning = { len: { S: [5, 13] as const }, hcp: [11, 21] as const, tp: [12, 22] as const }
    wrap(<AuctionBox auction={[{ seat: 'E', call: '1S', alert: 'stored text', robot: true, meaning }]} dealer="E" vul="None" />)
    await userEvent.click(screen.getByRole('button', { name: /Alert/ }))
    // The rules load on their own; until then the stored words show
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Alert' })).toHaveTextContent('5+ 張♠，11–21 大牌點，12–22 總點'))
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

  it('opens the seat’s menu when the plate is clicked', async () => {
    const onAddRobot = vi.fn()
    wrap(
      <SeatPlate
        seat="N"
        occupant={null}
        vulnerable={false}
        turn={false}
        isMe={false}
        actions={[
          { label: '坐 N', onSelect: () => {} },
          { label: '放機器人', onSelect: onAddRobot },
        ]}
      />,
    )
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /空位/ }))
    const menu = screen.getByRole('menu', { name: 'N 座位選項' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['坐 N', '放機器人'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: '放機器人' }))
    expect(onAddRobot).toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('names the robot TKB on its plate, with the system it bids; old ids are the club’s system', () => {
    wrap(
      <>
        <SeatPlate seat="N" occupant={{ id: 'robot:gib:N', username: 'Robot', robot: true, robotKind: 'gib', online: true }} vulnerable={false} turn={false} isMe={false} />
        <SeatPlate seat="E" occupant={{ id: 'robot:E', username: 'Robot', robot: true, online: true }} vulnerable={false} turn={false} isMe={false} />
      </>,
    )
    const plates = screen.getAllByText('TKB').map((name) => name.closest('[data-seat]')!)
    expect(plates.map((plate) => plate.querySelector('[data-system]')?.textContent)).toEqual(['2/1', '淡江制度'])
    expect(screen.queryByText('Robot')).toBeNull()
  })

  it('asks only how the table is run: no robot level', () => {
    wrap(<TableSettingsDialog title="開新桌" submitLabel="開桌" onSubmit={() => {}} onClose={() => {}} />)
    // The only list is the time limit
    expect(screen.getAllByRole('combobox').map((c) => c.getAttribute('id') && c.closest('fieldset')?.querySelector('legend')?.textContent)).toEqual([
      '每副時間上限',
    ])
  })

  it('counts down the board’s time on the plate of the player to act, red once it is over', () => {
    const { rerender } = wrap(
      <SeatPlate seat="W" occupant={{ id: 'u1', username: 'amy', online: true }} vulnerable={false} turn isMe={false} endsAt={Date.now() + 125_000} />,
    )
    expect(screen.getByRole('timer')).toHaveTextContent('2:05')
    rerender(
      <PreferencesProvider>
        <SeatPlate seat="W" occupant={{ id: 'u1', username: 'amy', online: true }} vulnerable={false} turn={false} isMe={false} endsAt={Date.now() + 125_000} />
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('timer')).toBeNull()
    rerender(
      <PreferencesProvider>
        <SeatPlate seat="W" occupant={{ id: 'u1', username: 'amy', online: true }} vulnerable={false} turn isMe={false} endsAt={Date.now() - 1} slow />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('timer')).toHaveTextContent('超時')
    expect(screen.getByText('已經等超過 1 分鐘')).toBeInTheDocument()
  })

  it('says whom a robot is sitting in for (代打)', () => {
    wrap(
      <SeatPlate
        seat="E"
        occupant={{ id: 'robot:tku:E', username: 'Robot', robot: true, robotKind: 'tku', online: true, substituteFor: 'amy' }}
        vulnerable={false}
        turn={false}
        isMe={false}
      />,
    )
    expect(screen.getByText('代打 amy')).toBeInTheDocument()
  })

  it('crowns the host, puts declarer and dummy at the right end, and has no menu without actions', () => {
    wrap(
      <SeatPlate
        seat="S"
        occupant={{ id: 'u1', username: 'gene', online: true }}
        vulnerable={false}
        turn={false}
        isMe={false}
        isHost
        role="declarer"
      />,
    )
    expect(screen.getByLabelText('房主')).toBeInTheDocument()
    expect(screen.getByText('莊家').parentElement?.style.marginLeft ?? '').toBe('')
    expect(screen.queryByRole('button')).toBeNull()
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
