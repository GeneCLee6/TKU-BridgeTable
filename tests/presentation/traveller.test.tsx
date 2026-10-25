import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import type { Traveller } from '../../shared/traveller.ts'
import { TravellerTable } from '../../src/components/Traveller.tsx'
import { ComparePage } from '../../src/pages/ComparePage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The traveller (e4-t32) and the side-by-side replay (e4-t33) */

const mocks = vi.hoisted(() => ({ api: { record: vi.fn() } }))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: `TKB ${seat}`, robot: true })
const amy = { id: 'amy', username: 'amy' }
const ben = { id: 'ben', username: 'ben' }

const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

/** South plays 7♦ with every card played, or stops after `cards` (as if claimed) */
function record(id: string, player: typeof amy, contract: string, cards = 52): BoardRecord {
  let board: BoardState = newBoard(1, hands)
  for (const call of [contract, 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < cards; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  if (cards < 52) board = { ...board, phase: 'finished', result: { declarerTricks: 13, scoreNS: 1440, claimed: true } }
  return {
    id,
    tableNumber: 0,
    finishedAt: 0,
    mode: 'challenge',
    eventId: 'c1',
    players: { N: robot('N'), E: robot('E'), S: player, W: robot('W') },
    board,
  }
}

const TRAVELLER: Traveller = {
  kind: 'challenge',
  eventId: 'c1',
  seq: 1,
  boardNo: 1,
  scoring: 'imp',
  entries: [
    {
      userId: 'amy',
      user: amy,
      boardId: 'b-amy',
      contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' },
      declarer: amy,
      lead: 'HK',
      declarerTricks: 11,
      scoreNS: 450,
      points: 1,
    },
    {
      userId: 'ben',
      user: ben,
      boardId: 'b-ben',
      contract: { level: 3, strain: 'N', doubled: 'X', declarer: 'N' },
      declarer: robot('N'),
      lead: null,
      declarerTricks: 8,
      scoreNS: -100,
      points: -1,
    },
  ],
}

const wrap = (node: React.ReactNode, path = '/') =>
  render(
    <PreferencesProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={node} />
          <Route path="/history/:recordId/vs/:otherId" element={node} />
        </Routes>
      </MemoryRouter>
    </PreferencesProvider>,
  )

beforeEach(() => {
  mocks.api.record.mockReset()
})

describe('TravellerTable (e4-t32)', () => {
  it('lists each result with contract, declarer, lead, result and scores; compares the others with mine', () => {
    wrap(<TravellerTable traveller={TRAVELLER} current="b-amy" compareFrom="b-amy" viewerId="amy" />)
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(rows[1]).toHaveTextContent(/^你4♠ Samy♥K\+1\+450\+1$/)
    expect(within(rows[1]).queryByRole('link')).toBeNull()
    expect(rows[2]).toHaveTextContent('3NTX N')
    expect(rows[2]).toHaveTextContent('-100')
    expect(within(rows[2]).getByRole('link', { name: 'ben' })).toHaveAttribute('href', '/history/b-ben')
    expect(within(rows[2]).getByRole('link', { name: /和ben並排看/ })).toHaveAttribute('href', '/history/b-amy/vs/b-ben')
  })

  it('leaves out the scoring column when nobody is ranked', () => {
    const unranked = { ...TRAVELLER, entries: TRAVELLER.entries.map(({ points: _p, ...e }) => e) }
    wrap(<TravellerTable traveller={unranked} />)
    expect(screen.queryByRole('columnheader', { name: 'IMP' })).toBeNull()
    expect(screen.queryByRole('link', { name: /並排看/ })).toBeNull()
  })
})

describe('ComparePage (e4-t33)', () => {
  it('replays both results together with one set of controls', async () => {
    mocks.api.record.mockImplementation(async (id: string) => ({
      record: id === 'b-amy' ? record('b-amy', amy, '7D') : record('b-ben', ben, '6D', 20),
    }))
    wrap(<ComparePage />, '/history/b-amy/vs/b-ben')
    expect(await screen.findByRole('heading', { name: 'amy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ben' })).toBeInTheDocument()
    expect(mocks.api.record).toHaveBeenCalledWith('b-amy')
    expect(mocks.api.record).toHaveBeenCalledWith('b-ben')
    // One replay for both, as long as the longer one
    const controls = screen.getAllByRole('group', { name: '逐墩重播' })
    expect(controls).toHaveLength(1)
    expect(within(controls[0]).getByLabelText('第 0 墩，共 13 墩')).toBeInTheDocument()
    await userEvent.click(within(controls[0]).getByRole('button', { name: '結尾' }))
    await waitFor(() => expect(within(controls[0]).getByLabelText('第 13 墩，共 13 墩')).toBeInTheDocument())
    expect(screen.getByText(/（攤牌）/)).toBeInTheDocument()
  })
})
