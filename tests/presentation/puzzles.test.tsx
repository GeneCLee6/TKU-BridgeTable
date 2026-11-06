import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '../../shared/messages.ts'
import type { AdminPuzzle, PuzzleSummary, PuzzleView } from '../../shared/puzzles.ts'
import { AdminPuzzles } from '../../src/components/AdminPuzzles.tsx'
import { cardName } from '../../src/lib/cards.ts'
import { PuzzleListPage, PuzzlePage } from '../../src/pages/PuzzlePages.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** The puzzle pages (`e10-t13`, `e10-t14`): they show what the server sends and ask it for the rest */

const mocks = vi.hoisted(() => ({
  api: {
    puzzles: vi.fn(),
    puzzle: vi.fn(),
    playPuzzle: vi.fn(),
    retryPuzzle: vi.fn(),
    puzzleHint: vi.fn(),
    revealPuzzle: vi.fn(),
  },
  admin: { puzzles: vi.fn(), publishPuzzle: vi.fn() },
}))

vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: { ...mocks.api, admin: mocks.admin },
}))

const p = STRINGS.zh.puzzles

const summary = (over: Partial<PuzzleSummary> = {}): PuzzleSummary => ({
  id: 'p01',
  level: 1,
  title: '解開阻塞',
  contract: { level: 3, strain: 'N' },
  status: 'new',
  solved: false,
  clean: false,
  revealed: false,
  ...over,
})

const view = (over: Partial<PuzzleView> = {}): PuzzleView => ({
  ...summary(),
  story: '3NT，剩下的要全拿',
  wonBefore: 3,
  need: 2,
  won: 0,
  hands: { N: ['SA', 'H2'], S: ['SK', 'HA'] },
  counts: { N: 2, E: 2, S: 2, W: 2 },
  gone: ['C2'],
  tricks: [],
  turn: 'S',
  legalCards: ['SK', 'HA'],
  wrong: null,
  hints: [],
  hintsLeft: 2,
  attempts: 0,
  failures: 0,
  ...over,
})

const admin = (over: Partial<AdminPuzzle> = {}): AdminPuzzle => ({
  id: 'p01',
  level: 1,
  status: 'draft',
  title: '解開阻塞',
  contract: { level: 3, strain: 'N' },
  wonBefore: 3,
  need: 2,
  leader: 'S',
  opening: [],
  story: '故事',
  hints: ['第一個提示'],
  explanation: '完整解說',
  hands: { N: ['SA'], E: ['S7'], S: ['SK'], W: ['S5'] },
  line: ['SK', 'S5', 'SA', 'S7'],
  size: 3,
  publishedBy: null,
  publishedAt: null,
  ...over,
})

const wrap = (path: string) =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/puzzles" element={<PuzzleListPage />} />
          <Route path="/puzzles/:puzzleId" element={<PuzzlePage />} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  for (const fn of [...Object.values(mocks.api), ...Object.values(mocks.admin)]) fn.mockReset()
})

describe('the list', () => {
  it('groups the published puzzles by level, with the member\'s progress', async () => {
    mocks.api.puzzles.mockResolvedValue({
      puzzles: [
        summary(),
        summary({ id: 'p02', title: '王吃', solved: true, clean: true, status: 'solved' }),
        summary({ id: 'p09', title: '緊逼', level: 3, status: 'playing' }),
      ],
    })
    wrap('/puzzles')
    expect(await screen.findByRole('heading', { name: p.level(1) })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: p.level(3) })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: p.level(2) })).not.toBeInTheDocument()
    expect(screen.getByText(p.levelProgress(1, 2))).toBeInTheDocument()
    expect(screen.getByText(p.clean)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '緊逼' })).toHaveAttribute('href', '/puzzles/p09')
    // The words are 繁中: nothing to say about that in 繁中
    expect(screen.queryByText(p.zhOnly)).not.toBeInTheDocument()
  })

  it('marks a puzzle whose answer was viewed, which does not count; one solved before viewing stays solved', async () => {
    mocks.api.puzzles.mockResolvedValue({
      puzzles: [
        summary({ title: '看過', status: 'revealed', revealed: true }),
        summary({ id: 'p02', title: '再打一次', status: 'playing', revealed: true }),
        summary({ id: 'p03', title: '先解開', status: 'revealed', revealed: true, solved: true, clean: true }),
      ],
    })
    wrap('/puzzles')
    expect(await screen.findByText(p.levelProgress(1, 3))).toBeInTheDocument()
    expect(screen.getAllByText(p.statusRevealed)).toHaveLength(2)
    expect(screen.queryByText(p.statusPlaying)).not.toBeInTheDocument()
    expect(screen.getByText(p.clean)).toBeInTheDocument()
  })

  it('says so when the club published none', async () => {
    mocks.api.puzzles.mockResolvedValue({ puzzles: [] })
    wrap('/puzzles')
    expect(await screen.findByText(p.none)).toBeInTheDocument()
  })
})

describe('a puzzle', () => {
  it('shows dummy and declarer open, the defenders face down, and sends a played card to the server', async () => {
    mocks.api.puzzle.mockResolvedValue({ puzzle: view() })
    mocks.api.playPuzzle.mockResolvedValue({ puzzle: view({ status: 'playing', attempts: 1, tricks: [{ leader: 'S', cards: ['SK'] }], turn: 'N', legalCards: ['SA'], hands: { N: ['SA', 'H2'], S: ['HA'] } }) })
    const user = userEvent.setup()
    wrap('/puzzles/p01')
    expect(await screen.findByText('3NT，剩下的要全拿')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: p.hiddenHand('W') })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: p.hiddenHand('E') })).toBeInTheDocument()

    const south = screen.getByRole('group', { name: p.declarer })
    await user.click(within(south).getAllByRole('button')[0])
    await waitFor(() => expect(mocks.api.playPuzzle).toHaveBeenCalledWith('p01', 'SK'))
    expect(await screen.findByText(p.yourTurn('N'))).toBeInTheDocument()
  })

  it('a wrong card: says so, and offers to take it back or start over', async () => {
    mocks.api.puzzle.mockResolvedValue({ puzzle: view({ status: 'failed', wrong: 'HA', legalCards: [], failures: 1, attempts: 1 }) })
    mocks.api.retryPuzzle.mockResolvedValue({ puzzle: view({ status: 'playing', failures: 1, attempts: 1 }) })
    const user = userEvent.setup()
    wrap('/puzzles/p01')
    expect(await screen.findByRole('alert')).toHaveTextContent(p.wrongCard)
    await user.click(screen.getByRole('button', { name: p.takeBack }))
    expect(mocks.api.retryPuzzle).toHaveBeenCalledWith('p01', 'mistake')
    await waitFor(() => expect(screen.queryByText(p.wrongCard)).not.toBeInTheDocument())
  })

  it('asks for hints one at a time, until there are none', async () => {
    mocks.api.puzzle.mockResolvedValue({ puzzle: view() })
    mocks.api.puzzleHint.mockResolvedValue({ puzzle: view({ hints: ['想想進手'], hintsLeft: 0, status: 'playing', attempts: 1 }) })
    const user = userEvent.setup()
    wrap('/puzzles/p01')
    await user.click(await screen.findByRole('button', { name: p.hintButton }))
    expect(await screen.findByText('想想進手')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: p.noHints })).toBeDisabled()
  })

  it('solved: the explanation and all four hands, as the server sent them', async () => {
    mocks.api.puzzle.mockResolvedValue({
      puzzle: view({
        status: 'solved',
        solved: true,
        turn: null,
        legalCards: [],
        explanation: '第二輪要超過',
        hands: { N: ['H2'], E: ['HK'], S: ['HA'], W: ['HJ'] },
        counts: { N: 1, E: 1, S: 1, W: 1 },
        startHands: { N: ['SA', 'H2'], E: ['S7', 'HK'], S: ['SK', 'HA'], W: ['S5', 'HJ'] },
      }),
    })
    wrap('/puzzles/p01')
    expect(await screen.findByText('第二輪要超過')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(p.solved)
    expect(screen.getByRole('heading', { name: p.startHands })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: p.hintButton })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: p.restart })).toBeInTheDocument()
  })

  describe('看答案', () => {
    const answered = (over: Partial<PuzzleView> = {}) =>
      view({
        status: 'revealed',
        revealed: true,
        turn: null,
        legalCards: [],
        attempts: 1,
        explanation: '第二輪要超過',
        hands: { N: ['SA', 'H2'], E: ['S7', 'HK'], S: ['SK', 'HA'], W: ['S5', 'HJ'] },
        startHands: { N: ['SA', 'H2'], E: ['S7', 'HK'], S: ['SK', 'HA'], W: ['S5', 'HJ'] },
        answer: { leader: 'S', line: ['SK', 'S5', 'SA', 'S7'], first: 0 },
        ...over,
      })

    it('asks first, saying it will not count; declining sends nothing', async () => {
      mocks.api.puzzle.mockResolvedValue({ puzzle: view() })
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const user = userEvent.setup()
      wrap('/puzzles/p01')
      await user.click(await screen.findByRole('button', { name: p.revealButton }))
      expect(confirm).toHaveBeenCalledWith(p.revealConfirm)
      expect(mocks.api.revealPuzzle).not.toHaveBeenCalled()
      expect(screen.getByRole('group', { name: p.hiddenHand('E') })).toBeInTheDocument()
      confirm.mockRestore()
    })

    it('after the yes: opens the hands and walks through the line one card at a time, nothing to play', async () => {
      mocks.api.puzzle.mockResolvedValue({ puzzle: view() })
      mocks.api.revealPuzzle.mockResolvedValue({ puzzle: answered() })
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const user = userEvent.setup()
      wrap('/puzzles/p01')
      await user.click(await screen.findByRole('button', { name: p.revealButton }))
      expect(mocks.api.revealPuzzle).toHaveBeenCalledWith('p01')
      expect(await screen.findByRole('heading', { name: p.answerTitle })).toBeInTheDocument()
      expect(screen.getByText(p.revealedNote)).toBeInTheDocument()
      expect(screen.getByText('第二輪要超過')).toBeInTheDocument()
      expect(screen.getByRole('group', { name: p.openHand('E') })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: p.revealButton })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: p.hintButton })).not.toBeInTheDocument()

      expect(screen.getByText(p.answerStep(0, 4))).toBeInTheDocument()
      expect(screen.getByRole('button', { name: p.answerPrev })).toBeDisabled()
      // The table follows: the card leaves South's hand for the trick, and comes back
      const inTrick = () => within(screen.getByRole('group', { name: p.trick })).queryAllByLabelText(cardName('SK', STRINGS.zh))
      const inSouth = () => within(screen.getByRole('group', { name: p.declarer })).queryAllByLabelText(cardName('SK', STRINGS.zh))
      expect(inTrick()).toHaveLength(0)
      expect(inSouth()).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: p.answerNext }))
      expect(screen.getByText(p.answerStep(1, 4))).toBeInTheDocument()
      expect(inTrick()).toHaveLength(1)
      expect(inSouth()).toHaveLength(0)
      await user.click(screen.getByRole('button', { name: p.answerPrev }))
      expect(screen.getByText(p.answerStep(0, 4))).toBeInTheDocument()
      expect(inTrick()).toHaveLength(0)
      for (let i = 0; i < 4; i++) await user.click(screen.getByRole('button', { name: p.answerNext }))
      expect(screen.getByRole('button', { name: p.answerNext })).toBeDisabled()
      expect(screen.getByText(p.answerEnd)).toBeInTheDocument()
      expect(mocks.api.playPuzzle).not.toHaveBeenCalled()
      confirm.mockRestore()
    })

    it('does not ask when there is nothing to lose: already solved, or seen before', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const user = userEvent.setup()
      mocks.api.puzzle.mockResolvedValue({ puzzle: view({ status: 'playing', solved: true, clean: true }) })
      mocks.api.revealPuzzle.mockResolvedValue({ puzzle: answered({ solved: true, clean: true }) })
      const first = wrap('/puzzles/p01')
      await user.click(await screen.findByRole('button', { name: p.revealButton }))
      expect(await screen.findByText(p.revealedKept)).toBeInTheDocument()
      first.unmount()

      mocks.api.puzzle.mockResolvedValue({ puzzle: view({ status: 'playing', revealed: true }) })
      mocks.api.revealPuzzle.mockResolvedValue({ puzzle: answered() })
      wrap('/puzzles/p01')
      expect(await screen.findByText(p.revealedRetrying)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: p.revealButton }))
      expect(await screen.findByText(p.revealedNote)).toBeInTheDocument()
      expect(confirm).not.toHaveBeenCalled()
      confirm.mockRestore()
    })

    it('finished right after viewing: says it does not count, not that it is solved', async () => {
      mocks.api.puzzle.mockResolvedValue({ puzzle: answered({ finishedAfterReveal: true }) })
      wrap('/puzzles/p01')
      expect(await screen.findByText(p.revealedFinished)).toBeInTheDocument()
      expect(screen.queryByText(p.solved)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: p.restart })).toBeInTheDocument()
    })
  })

  it('an unpublished puzzle shows the server\'s message', async () => {
    const { ApiError } = await import('../../src/lib/api.ts')
    mocks.api.puzzle.mockRejectedValue(new ApiError('gone', 404, 'puzzleGone'))
    wrap('/puzzles/p01')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('the admin section', () => {
  const adminWrap = () =>
    render(
      <PreferencesProvider>
        <AdminPuzzles />
      </PreferencesProvider>,
    )

  it('shows a draft in full and publishes it', async () => {
    mocks.admin.puzzles.mockResolvedValue({ puzzles: [admin()] })
    mocks.admin.publishPuzzle.mockResolvedValue({ puzzles: [admin({ status: 'published', publishedBy: 'boss', publishedAt: 1_000 })] })
    const user = userEvent.setup()
    adminWrap()
    expect(await screen.findByText('完整解說')).toBeInTheDocument()
    expect(screen.getByText(p.adminDraft)).toBeInTheDocument()
    expect(screen.getByText('第一個提示')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: p.adminPublish }))
    expect(mocks.admin.publishPuzzle).toHaveBeenCalledWith('p01', true)
    expect(await screen.findByRole('button', { name: p.adminUnpublish })).toBeInTheDocument()
    expect(screen.queryByText(p.adminDraft)).not.toBeInTheDocument()
  })
})

describe('the strings', () => {
  it('every language has the same puzzle words, and says the texts are 繁中', () => {
    const keys = Object.keys(STRINGS.zh.puzzles).sort()
    for (const lang of LANGS) {
      expect(Object.keys(STRINGS[lang].puzzles).sort()).toEqual(keys)
      expect(STRINGS[lang].puzzles.zhOnly.length).toBeGreaterThan(0)
    }
  })
})
