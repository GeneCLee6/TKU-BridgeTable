import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { PeopleList } from '../../src/components/PeopleList.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const person = (id: string, online: boolean): MemberStatus => ({ id, username: id, online, tableNumber: null, seat: null })

// As the server sends it: online first, the viewer's friends on top of each group
const LOBBY: LobbyView = {
  online: [],
  members: [person('zoe', true), person('amy', true), person('ben', true), person('kim', false), person('lee', false)],
  tables: [],
  myTableId: null,
  friends: ['zoe', 'kim'],
  blocked: ['lee'],
}

function show(lobby: LobbyView = LOBBY) {
  const send = vi.fn()
  render(
    <PreferencesProvider>
      <MemoryRouter>
        <PeopleList lobby={lobby} userId="amy" send={send} />
      </MemoryRouter>
    </PreferencesProvider>,
  )
  return send
}

const names = () => screen.getAllByRole('listitem').map((li) => li.textContent)

describe('PeopleList', () => {
  it('stars friends, marks blocked members, and has no buttons on your own row', () => {
    show()
    expect(screen.getByRole('button', { name: '把 zoe 移出好友' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '把 ben 加為好友' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '解除封鎖 lee' })).toHaveAttribute('aria-pressed', 'true')
    // A blocked member must be unblocked before they can be a friend again
    expect(screen.getByRole('button', { name: '把 lee 加為好友' })).toBeDisabled()
    const lee = screen.getAllByRole('listitem').find((li) => li.textContent?.startsWith('lee'))!
    expect(within(lee).getByText('已封鎖')).toBeInTheDocument()
    const me = screen.getAllByRole('listitem').find((li) => li.textContent?.startsWith('amy'))!
    // Only the name, which opens the profile card
    expect(within(me).getAllByRole('button').map((b) => b.textContent)).toEqual(['amy（你）'])
  })

  it('asks the server to follow, unfollow, block and unblock', async () => {
    const send = show()
    await userEvent.click(screen.getByRole('button', { name: '把 ben 加為好友' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setFriend', userId: 'ben', friend: true })
    await userEvent.click(screen.getByRole('button', { name: '把 zoe 移出好友' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setFriend', userId: 'zoe', friend: false })
    await userEvent.click(screen.getByRole('button', { name: '封鎖 ben' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setBlocked', userId: 'ben', blocked: true })
    await userEvent.click(screen.getByRole('button', { name: '解除封鎖 lee' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setBlocked', userId: 'lee', blocked: false })
  })

  it('shows only friends when asked, and says so when there are none', async () => {
    show()
    expect(names()).toHaveLength(5)
    await userEvent.click(screen.getByRole('button', { name: '只看好友' }))
    expect(screen.getByRole('button', { name: '只看好友' })).toHaveAttribute('aria-pressed', 'true')
    expect(names().map((n) => n?.slice(0, 3))).toEqual(['zoe', 'kim'])
    expect(screen.getByText('線上 1 人')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '只看好友' }))
    expect(names()).toHaveLength(5)
  })

  it('tells someone with no friends how to add one', async () => {
    show({ ...LOBBY, friends: [] })
    await userEvent.click(screen.getByRole('button', { name: '只看好友' }))
    expect(screen.getByText('還沒有好友：按名字旁的星星就能加入')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })
})
