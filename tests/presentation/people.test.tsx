import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureFlag } from '../../shared/features.ts'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { PeopleList } from '../../src/components/PeopleList.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

// The `friends` flag as a club may set it (shared/features.ts): null leaves the real hook
const flags = vi.hoisted(() => ({ friends: null as boolean | null }))
vi.mock('../../src/state/AuthContext.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/AuthContext.tsx')>()
  return {
    ...actual,
    useFeature: (flag: FeatureFlag) => (flag === 'friends' && flags.friends !== null ? flags.friends : actual.useFeature(flag)),
  }
})

afterEach(() => {
  flags.friends = null
})

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

function show(lobby: LobbyView = LOBBY, onMessage?: (userId: string) => void) {
  const send = vi.fn()
  render(
    <PreferencesProvider>
      <MemoryRouter>
        <PeopleList lobby={lobby} userId="amy" send={send} onMessage={onMessage} />
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

describe('PeopleList while the club has friends turned off (the `friends` flag)', () => {
  it('leaves only the envelope, and the ban button to undo an old block', async () => {
    flags.friends = false
    const onMessage = vi.fn()
    const send = show(LOBBY, onMessage)
    expect(screen.queryByRole('button', { name: /好友/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^封鎖/ })).toBeNull()
    // In the order the lobby gives them
    expect(names().map((n) => n?.slice(0, 3))).toEqual(['zoe', 'amy', 'ben', 'kim', 'lee'])
    const ben = screen.getAllByRole('listitem').find((li) => li.textContent?.startsWith('ben'))!
    expect(within(ben).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual([
      'ben',
      '傳私訊給 ben',
    ])
    await userEvent.click(within(ben).getByRole('button', { name: '傳私訊給 ben' }))
    expect(onMessage).toHaveBeenCalledWith('ben')
    await userEvent.click(screen.getByRole('button', { name: '解除封鎖 lee' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setBlocked', userId: 'lee', blocked: false })
  })
})

describe('PeopleList names (e11-t19)', () => {
  it("shows a member's display name, with the username in the tooltip", () => {
    show({ ...LOBBY, members: [{ ...person('ben', true), displayName: '陳小班' }, person('amy', true)] }, vi.fn())
    const ben = screen.getByRole('button', { name: /^陳小班/ })
    expect(ben).toHaveAttribute('title', expect.stringContaining('陳小班 (ben)'))
    expect(screen.getByRole('button', { name: '傳私訊給 陳小班' })).toBeInTheDocument()
  })
})
