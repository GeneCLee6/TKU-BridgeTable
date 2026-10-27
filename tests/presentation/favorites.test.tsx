import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tagSuggestions } from '../../shared/favorites.ts'
import type { HistoryQuery } from '../../shared/history-query.ts'
import type { BoardSummary, Favorite, FavoritesPage as Page } from '../../shared/protocol.ts'
import { FavoriteButton } from '../../src/components/FavoriteButton.tsx'
import { FavoriteNotes } from '../../src/components/FavoriteNotes.tsx'
import { resetFavorites } from '../../src/lib/favorites.ts'
import { FavoritesPage } from '../../src/pages/FavoritesPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Favorites (e4-t25…t27, AC-4.4): the star, 「我的收藏」 and editing notes and tags */

const mocks = vi.hoisted(() => ({
  api: {
    favoriteIds: vi.fn(),
    saveFavorite: vi.fn(),
    removeFavorite: vi.fn(),
    favorites: vi.fn(),
  },
}))
vi.mock('../../src/lib/api.ts', () => ({ api: mocks.api }))
vi.mock('../../src/state/ClubContext.tsx', () => ({ useLobby: () => ({ members: [] }) }))

const favorite = (boardId: string, note = '', tags: string[] = []): Favorite => ({ boardId, note, tags, createdAt: 0, updatedAt: 0 })

beforeEach(() => {
  resetFavorites()
  for (const fn of Object.values(mocks.api)) fn.mockReset()
  mocks.api.favoriteIds.mockResolvedValue({ ids: ['b1'] })
  mocks.api.saveFavorite.mockImplementation(async (id: string, change: { note?: string; tags?: string[] } = {}) => ({
    favorite: favorite(id, change.note, change.tags),
  }))
  mocks.api.removeFavorite.mockResolvedValue({ ok: true })
})

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('the favorite star (e4-t25)', () => {
  it('shows what is kept and keeps or drops a board, every star of it at once', async () => {
    const user = userEvent.setup()
    wrap(
      <>
        <FavoriteButton boardId="b1" />
        <div data-testid="two">
          <FavoriteButton boardId="b2" />
        </div>
        <div data-testid="again">
          <FavoriteButton boardId="b2" />
        </div>
      </>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '取消收藏' })).toHaveAttribute('aria-pressed', 'true'))
    expect(mocks.api.favoriteIds).toHaveBeenCalledTimes(1)
    await user.click(within(screen.getByTestId('two')).getByRole('button', { name: '收藏' }))
    expect(mocks.api.saveFavorite).toHaveBeenCalledWith('b2')
    expect(within(screen.getByTestId('again')).getByRole('button')).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getAllByRole('button', { name: '取消收藏' })[0])
    expect(mocks.api.removeFavorite).toHaveBeenCalledWith('b1')
  })

  it('takes the change back when the server refuses it', async () => {
    const user = userEvent.setup()
    mocks.api.saveFavorite.mockRejectedValue(Object.assign(new Error('找不到這副牌'), { code: 'boardGone', params: {} }))
    wrap(<FavoriteButton boardId="b2" />)
    const star = await screen.findByRole('button', { name: '收藏' })
    await waitFor(() => expect(star).toBeEnabled())
    await user.click(star)
    await waitFor(() => expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'false'))
  })
})

describe('notes and tags (e4-t27)', () => {
  it('offers the member\'s own tags while typing', () => {
    const known = [
      { tag: '首攻', count: 3 },
      { tag: '防守', count: 2 },
      { tag: 'Slam', count: 1 },
    ]
    expect(tagSuggestions(known, [], '首')).toEqual(['首攻'])
    expect(tagSuggestions(known, ['首攻'], '首')).toEqual([])
    expect(tagSuggestions(known, [], 'sl')).toEqual(['Slam'])
    expect(tagSuggestions(known, [], ' ')).toEqual([])
  })

  it('edits the note and tags in place', async () => {
    const user = userEvent.setup()
    const onSaved = vi.fn()
    wrap(<FavoriteNotes favorite={favorite('b1', '舊筆記', ['防守'])} known={[{ tag: '首攻', count: 2 }]} onSaved={onSaved} />)
    expect(screen.getByText('舊筆記')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '編輯筆記與標籤' }))
    const note = screen.getByLabelText('筆記')
    await user.clear(note)
    await user.type(note, '新筆記')
    await user.click(screen.getByRole('button', { name: '移除標籤「防守」' }))
    const tags = screen.getByLabelText('標籤')
    await user.type(tags, '首')
    await user.click(screen.getByRole('button', { name: '首攻' }))
    await user.type(tags, '坐莊{Enter}')
    await user.click(screen.getByRole('button', { name: '儲存' }))
    expect(mocks.api.saveFavorite).toHaveBeenCalledWith('b1', { note: '新筆記', tags: ['首攻', '坐莊'] })
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(favorite('b1', '新筆記', ['首攻', '坐莊'])))
  })
})

const board = (id: string, boardNo: number): BoardSummary =>
  ({
    id,
    tableNumber: 1,
    finishedAt: 0,
    players: { N: { id: 'a', username: 'amy' }, E: { id: 'b', username: 'ben' }, S: { id: 'c', username: 'cat' }, W: { id: 'd', username: 'dan' } },
    boardNo,
    dealer: 'N',
    vul: 'None',
    contract: { level: 4, strain: 'S', declarer: 'N', doubled: '' },
    result: { declarerTricks: 10, scoreNS: 420, claimed: false },
  }) as BoardSummary

describe('「我的收藏」 (e4-t26)', () => {
  it('lists the favorites with their notes and filters by tag in the address', async () => {
    const user = userEvent.setup()
    mocks.api.favoriteIds.mockResolvedValue({ ids: ['b1', 'b2'] })
    mocks.api.favorites.mockImplementation(
      async (query: Partial<HistoryQuery>): Promise<Page> => ({
        boards: query.tag ? [board('b1', 7)] : [board('b1', 7), board('b2', 9)],
        total: query.tag ? 1 : 2,
        page: 1,
        size: 20,
        favorites: [favorite('b1', '首攻要攻黑桃', ['首攻']), favorite('b2')],
        tags: [{ tag: '首攻', count: 1 }],
      }),
    )
    wrap(
      <MemoryRouter initialEntries={['/favorites']}>
        <Routes>
          <Route path="/favorites" element={<FavoritesPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('首攻要攻黑桃')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '第 1 桌 #9' })).toHaveAttribute('href', '/history/b2')
    await user.click(screen.getByRole('button', { name: '首攻 1' }))
    await waitFor(() => expect(mocks.api.favorites).toHaveBeenLastCalledWith(expect.objectContaining({ tag: '首攻' })))
    await waitFor(() => expect(screen.queryByRole('link', { name: '第 1 桌 #9' })).not.toBeInTheDocument())
    // The tag shows as a removable chip like the other conditions
    expect(screen.getByRole('button', { name: /標籤：首攻/ })).toBeInTheDocument()
  })
})
