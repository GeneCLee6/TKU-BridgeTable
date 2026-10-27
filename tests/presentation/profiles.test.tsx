import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FRIENDS_ENABLED } from '../../shared/features.ts'
import type { MemberProfile } from '../../shared/profile.ts'
import type { LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { PeopleList } from '../../src/components/PeopleList.tsx'
import { avatarInitials, avatarSlot } from '../../src/lib/avatar.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { AccountPage } from '../../src/pages/AccountPage.tsx'

const person = (id: string, online: boolean): MemberStatus => ({ id, username: id, online, tableNumber: null, seat: null })

const LOBBY: LobbyView = {
  online: [],
  members: [person('amy', true), person('ben', true), person('lee', false)],
  tables: [],
  myTableId: null,
  friends: ['ben'],
  blocked: ['lee'],
}

const BEN: MemberProfile = {
  id: 'ben',
  username: 'ben',
  profile: { displayName: '林大偉', level: 'college', system: '淡江制度', bio: '大二\n喜歡打防守' },
  recent: [
    {
      id: 'b1',
      tableNumber: 2,
      finishedAt: Date.UTC(2026, 9, 24, 12),
      boardNo: 6,
      dealer: 'N',
      vul: 'None',
      contract: { level: 4, strain: 'S', declarer: 'N', doubled: '' },
      result: { declarerTricks: 10, scoreNS: 420, claimed: false },
      players: Object.fromEntries(['N', 'E', 'S', 'W'].map((s) => [s, { id: s, username: s }])) as MemberProfile['recent'][0]['players'],
    },
  ],
}

function show(onMessage = vi.fn()) {
  const asked: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify({ member: { ...BEN, id: url.split('/').pop() } }), { status: 200 })
    }),
  )
  const send = vi.fn()
  render(
    <PreferencesProvider>
      <MemoryRouter>
        <PeopleList lobby={LOBBY} userId="amy" send={send} onMessage={onMessage} />
      </MemoryRouter>
    </PreferencesProvider>,
  )
  return { send, asked, onMessage }
}

afterEach(() => vi.unstubAllGlobals())

describe('profile card (e1-t17)', () => {
  it('opens from a name with the profile and the latest boards', async () => {
    const { asked } = show()
    await userEvent.click(screen.getByRole('button', { name: 'ben' }))
    const card = await screen.findByRole('dialog', { name: 'ben 的個人檔案' })
    expect(asked).toEqual(['/api/members/ben'])
    expect(await within(card).findByRole('heading', { name: '林大偉' })).toBeInTheDocument()
    expect(within(card).getByText('帳號 ben')).toBeInTheDocument()
    expect(within(card).getByText('大專')).toBeInTheDocument()
    expect(within(card).getByText('淡江制度')).toBeInTheDocument()
    expect(within(card).getByText(/喜歡打防守/)).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: /第 2 桌 第 6 副/ })).toHaveAttribute('href', '/history/b1')
    expect(within(card).getByRole('link', { name: '完整個人檔案' })).toHaveAttribute('href', '/members/ben')
  })

  it.skipIf(!FRIENDS_ENABLED)('friends, blocks and messages from the card', async () => {
    const { send, onMessage } = show()
    await userEvent.click(screen.getByRole('button', { name: 'ben' }))
    const card = await screen.findByRole('dialog')
    await userEvent.click(await within(card).findByRole('button', { name: '把 ben 移出好友' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setFriend', userId: 'ben', friend: false })
    await userEvent.click(within(card).getByRole('button', { name: '封鎖 ben' }))
    expect(send).toHaveBeenLastCalledWith({ type: 'setBlocked', userId: 'ben', blocked: true })
    await userEvent.click(within(card).getByRole('button', { name: '傳私訊給 ben' }))
    expect(onMessage).toHaveBeenCalledWith('ben')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.runIf(!FRIENDS_ENABLED)('only messages from the card while friends are hidden (FRIENDS_ENABLED)', async () => {
    const { send, onMessage } = show()
    await userEvent.click(screen.getByRole('button', { name: 'ben' }))
    const card = await screen.findByRole('dialog')
    await userEvent.click(await within(card).findByRole('button', { name: '傳私訊給 ben' }))
    expect(onMessage).toHaveBeenCalledWith('ben')
    expect(send).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // A member blocked before can still be unblocked
    await userEvent.click(screen.getByRole('button', { name: 'lee' }))
    const lee = await screen.findByRole('dialog')
    expect(await within(lee).findByRole('button', { name: '解除封鎖 lee' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(lee).queryByRole('button', { name: /好友/ })).toBeNull()
  })

  it.skipIf(!FRIENDS_ENABLED)('lets a blocked member only be unblocked, and closes with Escape', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'lee' }))
    const card = await screen.findByRole('dialog')
    expect(await within(card).findByRole('button', { name: '把 lee 加為好友' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '傳私訊給 lee' })).toBeDisabled()
    expect(within(card).getByRole('button', { name: '解除封鎖 lee' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('has no friend or block buttons on your own card, but a way to edit it', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'amy（你）' }))
    const card = await screen.findByRole('dialog')
    expect(await within(card).findByRole('link', { name: '編輯個人檔案' })).toHaveAttribute('href', '/account')
    expect(within(card).queryByRole('button', { name: /好友|封鎖|私訊/ })).toBeNull()
  })
})

describe('default avatars (e1-t18)', () => {
  it('uses one character of a CJK name and up to two Latin initials', () => {
    expect(avatarInitials('王小明')).toBe('王')
    expect(avatarInitials('Gene Lee')).toBe('GL')
    expect(avatarInitials('amy')).toBe('A')
    expect(avatarInitials('amy_chen.tw')).toBe('AC')
    expect(avatarInitials('  ')).toBe('?')
  })

  it('picks the same colour for the same id, spread over the palette', () => {
    expect(avatarSlot('user-1', 10)).toBe(avatarSlot('user-1', 10))
    const slots = new Set(Array.from({ length: 50 }, (_, i) => avatarSlot(`member-${i}`, 10)))
    expect(slots.size).toBeGreaterThan(5)
    for (const slot of slots) expect(slot).toBeLessThan(10)
  })
})

describe('my account: the profile form (e1-t16)', () => {
  function account(answer: (body: Record<string, unknown>) => Response) {
    let me: Record<string, unknown> = { id: 'amy', username: 'amy', admin: false, permissions: [], profile: { displayName: 'Amy' } }
    const patches: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/account/profile' && init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          patches.push(body)
          const response = answer(body)
          if (response.ok) me = { ...me, profile: body }
          return response
        }
        return new Response(JSON.stringify({ user: me }), { status: 200 })
      }),
    )
    render(
      <PreferencesProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter>
              <AccountPage />
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </PreferencesProvider>,
    )
    return patches
  }

  const profileForm = () => screen.getByRole('form', { name: '個人檔案' })

  it('fills in the saved profile, saves changes and says so', async () => {
    const patches = account((body) => new Response(JSON.stringify({ user: { id: 'amy', profile: body } }), { status: 200 }))
    const name = await screen.findByDisplayValue('Amy')
    await userEvent.clear(name)
    await userEvent.type(name, '陳怡君')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '自評等級' }), 'open')
    await userEvent.type(screen.getByRole('textbox', { name: '常用制度' }), '2/1')
    await userEvent.click(within(profileForm()).getByRole('button', { name: '儲存' }))
    expect(patches.at(-1)).toEqual({ displayName: '陳怡君', level: 'open', system: '2/1', bio: '' })
    expect(await screen.findByText('個人檔案已儲存')).toBeInTheDocument()
  })

  it('puts a server error under its field', async () => {
    account(() => new Response(JSON.stringify({ error: 'x', code: 'profileSystemTooLong', params: { max: 40 } }), { status: 400 }))
    await screen.findByDisplayValue('Amy')
    const system = screen.getByRole('textbox', { name: '常用制度' })
    await userEvent.type(system, 'Precision')
    await userEvent.click(within(profileForm()).getByRole('button', { name: '儲存' }))
    expect(await screen.findByText('常用制度最多 40 個字')).toBeInTheDocument()
    expect(system).toHaveAttribute('aria-invalid', 'true')
  })
})
