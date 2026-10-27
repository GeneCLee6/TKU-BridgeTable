import { act, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trick } from '../../shared/game.ts'
import { AppHeader } from '../../src/components/AppHeader.tsx'
import { HandView } from '../../src/components/HandView.tsx'
import { LAST_TRICK_STEP_MS, TrickPile } from '../../src/components/TrickPile.tsx'
import { suitOrder } from '../../src/lib/cards.ts'
import { REPLAY_CARD_MS, useTrickReplay } from '../../src/lib/useTrickReplay.ts'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { ClubProvider } from '../../src/state/ClubContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { HistoryPage } from '../../src/pages/HistoryPage.tsx'

const wrap = (ui: ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)
const cardNames = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label'))

describe('the order of suits in a hand', () => {
  it('alternates black and red, and puts trumps first', () => {
    expect(suitOrder(null)).toEqual(['S', 'H', 'C', 'D'])
    expect(suitOrder('N')).toEqual(['S', 'H', 'C', 'D'])
    expect(suitOrder('S')).toEqual(['S', 'H', 'C', 'D'])
    expect(suitOrder('H')).toEqual(['H', 'S', 'D', 'C'])
    expect(suitOrder('D')).toEqual(['D', 'S', 'H', 'C'])
    expect(suitOrder('C')).toEqual(['C', 'H', 'S', 'D'])
  })

  it('keeps the colours apart around a void', () => {
    // No hearts: ♠ ♣ ♦ would put two black suits together
    const order = suitOrder(null, ['S', 'D', 'C']).filter((s) => s !== 'H')
    expect(order).toEqual(['S', 'D', 'C'])
  })

  it('draws a hand in that order', () => {
    wrap(<HandView cards={['SA', 'H2', 'D3', 'C4']} count={4} width={60} order={suitOrder('D')} label="S" />)
    expect(cardNames(screen.getByRole('group', { name: 'S' }))).toEqual(['方塊3', '黑桃A', '紅心2', '梅花4'])
  })

  it('lays a side dummy out in rows, trumps on top', () => {
    wrap(<HandView cards={['SA', 'SK', 'H2', 'D3', 'C4', 'C5']} count={6} width={60} orientation="rows" order={suitOrder('C')} label="W" />)
    const rows = [...screen.getByRole('group', { name: 'W' }).children] as HTMLElement[]
    expect(rows).toHaveLength(4)
    expect(cardNames(rows[0])).toEqual(['梅花5', '梅花4'])
    expect(cardNames(rows[2])).toEqual(['黑桃A', '黑桃K'])
  })
})

describe('the trick pile', () => {
  const tricks: Trick[] = [
    { leader: 'W', winner: 'N', cards: [{ seat: 'W', card: 'S2' }, { seat: 'N', card: 'SA' }, { seat: 'E', card: 'S3' }, { seat: 'S', card: 'S4' }] },
    { leader: 'N', winner: 'E', cards: [{ seat: 'N', card: 'H2' }, { seat: 'E', card: 'HA' }, { seat: 'S', card: 'H3' }, { seat: 'W', card: 'H4' }] },
    { leader: 'E', cards: [{ seat: 'E', card: 'D2' }] },
  ]
  const positions = { N: 'top', E: 'right', S: 'bottom', W: 'left' } as const

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stands tricks we won upright, lays the others down, and plays the last one again on a click', async () => {
    const onToggle = vi.fn()
    const { rerender } = wrap(
      <TrickPile tricks={tricks} side="NS" positionOf={(s) => positions[s]} width={80} open={false} onToggle={onToggle} />,
    )
    const pile = screen.getByRole('button', { name: /我方 1、對方 1/ })
    expect([...pile.children].map((c) => c.getAttribute('data-ours'))).toEqual(['true', 'false'])
    await userEvent.click(pile)
    expect(onToggle).toHaveBeenCalled()

    vi.useFakeTimers()
    rerender(
      <PreferencesProvider>
        <TrickPile tricks={tricks} side="NS" positionOf={(s) => positions[s]} width={80} open onToggle={onToggle} />
      </PreferencesProvider>,
    )
    const last = screen.getByRole('dialog', { name: '上一墩' })
    const shown = () => within(last).getAllByRole('button').map((b) => b.getAttribute('aria-label'))
    // One card at a time, in the order they were played
    expect(shown()).toEqual(['紅心2'])
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(LAST_TRICK_STEP_MS))
    expect(shown()).toEqual(['紅心2', '紅心A', '紅心3', '紅心4'])
  })
})

describe('replaying a board', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('plays one trick per step, card by card, and waits for the trick to finish', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTrickReplay(52))
    expect(result.current.tricks).toBe(13)

    act(() => result.current.next())
    expect(result.current.step).toBe(1)
    expect(result.current.playing).toBe(true)
    // Clicking again mid-trick does nothing
    act(() => result.current.next())
    expect(result.current.step).toBe(1)

    for (const shown of [2, 3, 4]) {
      act(() => vi.advanceTimersByTime(REPLAY_CARD_MS))
      expect(result.current.step).toBe(shown)
    }
    expect(result.current.playing).toBe(false)
    expect(result.current.trick).toBe(1)

    act(() => result.current.next())
    for (let i = 0; i < 3; i++) act(() => vi.advanceTimersByTime(REPLAY_CARD_MS))
    expect(result.current.step).toBe(8)
    act(() => result.current.prev())
    expect(result.current.step).toBe(4)
    act(() => result.current.end())
    expect(result.current.trick).toBe(13)
  })
})

describe('the language menu', () => {
  it('lists six languages and switches to the one picked', async () => {
    render(
      <PreferencesProvider>
        <AuthProvider>
          <ClubProvider>
            <MemoryRouter>
              <AppHeader />
            </MemoryRouter>
          </ClubProvider>
        </AuthProvider>
      </PreferencesProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: '語言' }))
    const items = within(screen.getByRole('menu')).getAllByRole('menuitemradio')
    expect(items.map((i) => i.textContent)).toEqual(['繁體中文', '简体中文', 'English', 'Tiếng Việt', '日本語', '한국어'])
    expect(items[0]).toHaveAttribute('aria-checked', 'true')

    await userEvent.click(items[4])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.documentElement.lang).toBe('ja')
    expect(screen.getByRole('button', { name: '言語' })).toBeInTheDocument()
  })

  it('leaves the card style and deck colours to the table (社長 #8)', () => {
    render(
      <PreferencesProvider>
        <AuthProvider>
          <ClubProvider>
            <MemoryRouter>
              <AppHeader />
            </MemoryRouter>
          </ClubProvider>
        </AuthProvider>
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('button', { name: '改用文字牌（♠ A K Q）' })).toBeNull()
    expect(screen.queryByRole('button', { name: '改用實體牌' })).toBeNull()
    expect(screen.queryByRole('button', { name: '改用四色牌' })).toBeNull()
  })
})

describe('the history list', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pages through the boards and lets the viewer choose how many a page shows', async () => {
    const asked: URLSearchParams[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const query = new URL(input, 'http://x').searchParams
        asked.push(query)
        const size = Number(query.get('size') ?? 20)
        const page = Number(query.get('page') ?? 1)
        const board = (n: number) => ({
          id: `b${n}`,
          tableNumber: 1,
          finishedAt: n,
          boardNo: n,
          dealer: 'N',
          vul: 'None',
          contract: null,
          result: { declarerTricks: 0, scoreNS: 0, claimed: false },
          players: Object.fromEntries(['N', 'E', 'S', 'W'].map((s) => [s, { id: s, username: s }])),
        })
        const boards = Array.from({ length: Math.min(size, 45 - (page - 1) * size) }, (_, i) => board((page - 1) * size + i + 1))
        return new Response(JSON.stringify({ boards, total: 45, page, size }), { status: 200 })
      }),
    )
    render(
      <PreferencesProvider>
        <MemoryRouter initialEntries={['/history?group=none']}>
          <HistoryPage />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(await screen.findByText('第 1–20 副，共 45 副')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(21)
    await userEvent.click(screen.getByRole('button', { name: '3' }))
    expect(await screen.findByText('第 41–45 副，共 45 副')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下一頁' })).toBeDisabled()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /每頁/ }), '50')
    expect(await screen.findByText('第 1–45 副，共 45 副')).toBeInTheDocument()
    expect(asked.at(-1)?.get('size')).toBe('50')
    expect(asked.at(-1)?.get('page') ?? '1').toBe('1')
    // All on one page: -- for every passed-out board
    expect(screen.getAllByText('--')).toHaveLength(45)
  })
})
