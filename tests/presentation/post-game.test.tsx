import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { DdTooComplex, type DdPositionRaw, type DdPositionRequest } from '../../src/lib/doubleDummy.ts'
import { PostGamePage } from '../../src/pages/PostGamePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The post-game analysis page (`e10-t12`). The server and DDS are mocked; dd-steps.test.ts checks the real numbers. */

const mocks = vi.hoisted(() => ({
  solve: vi.fn(),
  cancel: vi.fn(),
  api: { session: vi.fn() },
}))
vi.mock('../../src/lib/useDoubleDummy.ts', () => ({
  solvePosition: (request: DdPositionRequest) => ({ result: mocks.solve(request) as Promise<DdPositionRaw>, cancel: mocks.cancel }),
}))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

/** Each seat one suit: N ♠, E ♥, S ♦, W ♣ */
const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: `TKB ${seat}`, robot: true })

/**
 * 7♦ by South, every card played: West leads `lead`, everyone then plays their lowest. Each test
 * has its own lead, since a board worked out once is kept and the same cards are not asked again.
 */
function playedBoard(lead = 'C2', boardNo = 1): BoardState {
  let board: BoardState = newBoard(1, hands)
  for (const call of ['P', 'P', '7D', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, i === 0 ? lead : legalCards(board, seat).at(-1)!)
  }
  return { ...board, boardNo }
}

const record = (id: string, board: BoardState): BoardRecord => ({
  id,
  tableNumber: 3,
  finishedAt: 0,
  mode: 'casual',
  players: { N: robot('N'), E: robot('E'), S: { id: 'amy', username: 'amy' }, W: { id: 'bob', username: 'bob' } },
  board,
})

/** DDS's answer: every card of the hand to play worth 0, but West's first lead: ♣A worth 1, so his ♣2 lost one */
function answer(request: DdPositionRequest): DdPositionRaw {
  const left = request.remainCards.slice(2).split(' ')
  const played = request.currentTrickRank.filter(Boolean).length
  const hand = left[(request.first + played) % 4]
  const suit = hand.split('.').findIndex(Boolean)
  const lead = played === 0 && request.first === 3 && hand.length === 16
  const mask = (ranks: string) => [...ranks].reduce((bits, r) => bits | (1 << (14 - 'AKQJT98765432'.indexOf(r))), 0)
  const ranks = hand.split('.')[suit]
  if (lead) return { suit: [suit, suit], rank: [14, 13], equals: [0, mask(ranks.slice(2))], score: [1, 0] }
  return { suit: [suit], rank: [14 - 'AKQJT98765432'.indexOf(ranks[0])], equals: [mask(ranks.slice(1))], score: [0] }
}

function show(path = '/history/a/analysis') {
  return render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/history/:recordId/analysis" element={<PostGamePage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )
}

beforeEach(() => {
  mocks.solve.mockReset()
  mocks.cancel.mockReset()
  mocks.api.session.mockReset()
  mocks.solve.mockImplementation(async (request: DdPositionRequest) => answer(request))
})

describe('the post-game analysis page', () => {
  it('reads the session of the record it was opened from', async () => {
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard())] })
    show()
    await screen.findByRole('heading', { name: /賽後分析/ })
    expect(mocks.api.session).toHaveBeenCalledWith('a')
  })

  it('lists the costliest card of a board, the best card and the way to that step', async () => {
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard())] })
    show()
    const moves = await screen.findByRole('list', { name: '損失最大的幾步' })
    const item = within(moves).getByRole('listitem')
    expect(item).toHaveTextContent('第 1 墩')
    expect(item).toHaveTextContent('bob')
    expect(item).toHaveTextContent('這張牌少了 1 墩')
    // The card played, then the best card
    expect(within(item).getByRole('img', { name: /梅花.*2|♣.*2/ })).toBeInTheDocument()
    expect(within(item).getByRole('img', { name: /梅花.*A|♣.*A/ })).toBeInTheDocument()
    expect(within(item).getByRole('link', { name: '看這一步' })).toHaveAttribute('href', '/history/a?step=1')
    await screen.findByText('分析完成。')
    expect(screen.getByText('莊家方少 0 墩，防家方少 1 墩')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '52')
  })

  it('says “too complex” for a step over the budget and gives no number for it', async () => {
    mocks.solve.mockImplementation(async () => {
      throw new DdTooComplex()
    })
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard('C3'))] })
    show()
    await screen.findByText('分析完成。')
    // Every step with a choice went over; the last trick has none
    expect(screen.getByText(/48 步太複雜（超過 8 秒），沒有算進來/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '損失最大的幾步' })).toBeNull()
    expect(screen.queryByText(/這張牌少了/)).toBeNull()
  })

  it('says the solver failed rather than showing a finished board', async () => {
    mocks.solve.mockImplementation(async () => {
      throw new Error('boom')
    })
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard('C4'))] })
    show()
    expect(await screen.findByRole('alert')).toHaveTextContent('無法計算雙夢家分析')
    expect(screen.queryByText(/莊家方少/)).toBeNull()
    expect(screen.queryByText('分析完成。')).toBeNull()
  })

  it('stops and goes on from where it was', async () => {
    const waiting: (() => void)[] = []
    mocks.solve.mockImplementation((request: DdPositionRequest) => new Promise((resolve) => waiting.push(() => resolve(answer(request)))))
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard('C5'))] })
    show()
    await userEvent.click(await screen.findByRole('button', { name: '停止' }))
    expect(mocks.cancel).toHaveBeenCalled()
    expect(screen.getByText(/已停止/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()

    mocks.solve.mockImplementation(async (request: DdPositionRequest) => answer(request))
    await userEvent.click(screen.getByRole('button', { name: '繼續' }))
    await screen.findByText('分析完成。')
  })

  it('goes through the boards one after another, those it can', async () => {
    const passed: BoardState = { ...newBoard(2, hands), phase: 'finished', contract: null }
    const partial: BoardState = { ...playedBoard('C8', 3), hands: { ...hands, N: hands.N.slice(1) } }
    mocks.api.session.mockResolvedValue({ records: [record('a', playedBoard('C6', 1)), record('b', passed), record('c', partial), record('d', playedBoard('C7', 4))] })
    show()
    await screen.findByText('分析完成。')
    expect(within(screen.getByRole('region', { name: '第 2 副' })).getByText('四家都 Pass，沒有打牌。')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '第 3 副' })).getByText(/無法分析/)).toBeInTheDocument()
    // Two boards with 52 cards: the page's total does not count those it cannot analyse
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '104')
    await waitFor(() => expect(screen.getAllByRole('list', { name: '損失最大的幾步' })).toHaveLength(2))
  })

  it('shows the server’s answer for a record the member may not read, and solves nothing', async () => {
    mocks.api.session.mockRejectedValue(Object.assign(new Error('gone'), { code: 'boardGone' }))
    show()
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mocks.solve).not.toHaveBeenCalled()
  })

  it('analyses nothing from a board still being played', async () => {
    const unfinished: BoardState = { ...playedBoard('C9'), phase: 'play' }
    mocks.api.session.mockResolvedValue({ records: [record('a', unfinished)] })
    show()
    await screen.findByText(/無法分析/)
    expect(mocks.solve).not.toHaveBeenCalled()
  })

  it('every language has the page’s words', async () => {
    const { STRINGS } = await import('../../src/strings.ts')
    for (const lang of ['zh', 'zh-Hans', 'en', 'vi', 'ja', 'ko'] as const) {
      const words = STRINGS[lang].postGame
      expect(words.title).toBeTruthy()
      expect(words.progress(1, 2)).toContain('1')
      expect(words.tooComplex(3, 8)).toContain('8')
      expect(STRINGS[lang].ddCardLost(2)).toContain('2')
      expect(STRINGS[lang].ddTooComplex).toBeTruthy()
    }
  })
})
