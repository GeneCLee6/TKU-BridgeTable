import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { DirectMessage, DirectPage, DirectsView, LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { DirectMessages, type DirectMessagesProps } from '../../src/components/DirectMessages.tsx'
import { PeopleList } from '../../src/components/PeopleList.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const msg = (id: number, from: string, to: string, text: string): DirectMessage => ({ id, from, to, text, at: 1_700_000_000_000 + id })

const DIRECTS: DirectsView = {
  unread: 2,
  conversations: [
    { user: { id: 'ben', username: 'ben' }, last: msg(5, 'ben', 'amy', 'see you'), unread: 2 },
    { user: { id: 'cat', username: 'cat' }, last: msg(3, 'amy', 'cat', 'thanks'), unread: 0 },
  ],
}

function show(props: Partial<DirectMessagesProps> = {}) {
  const all: DirectMessagesProps = {
    me: 'amy',
    directs: DIRECTS,
    live: [],
    members: [{ id: 'zoe', username: 'zoe' }],
    blocked: [],
    talkTo: null,
    onTalkTo: vi.fn(),
    send: vi.fn(),
    load: vi.fn(async (): Promise<DirectPage> => ({ messages: [], more: false })),
    ...props,
  }
  const view = render(
    <PreferencesProvider>
      <DirectMessages {...all} />
    </PreferencesProvider>,
  )
  return { ...all, rerender: (next: Partial<DirectMessagesProps>) => view.rerender(
    <PreferencesProvider>
      <DirectMessages {...all} {...next} />
    </PreferencesProvider>,
  ) }
}

describe('DirectMessages', () => {
  it('lists conversations newest first with unread counts, and opens one', async () => {
    const { onTalkTo } = show()
    const rows = screen.getAllByRole('button')
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual(['ben · 2 則未讀', 'cat'])
    expect(rows[1]).toHaveTextContent('你：thanks')
    await userEvent.click(rows[0])
    expect(onTalkTo).toHaveBeenCalledWith('ben')
  })

  it('says how to start when there are none', () => {
    show({ directs: { conversations: [], unread: 0 } })
    expect(screen.getByText(/還沒有私訊/)).toBeInTheDocument()
  })

  it('loads a conversation, adds arriving messages, marks it read, pages back and sends', async () => {
    const load = vi.fn(async (_userId: string, before?: number): Promise<DirectPage> =>
      before
        ? { messages: [msg(1, 'ben', 'amy', 'first')], more: false }
        : { messages: [msg(4, 'amy', 'ben', 'hello'), msg(5, 'ben', 'amy', 'see you')], more: true },
    )
    const { send, rerender } = show({ talkTo: 'ben', load })
    expect(await screen.findByText('see you')).toBeInTheDocument()
    expect(load).toHaveBeenCalledWith('ben')
    expect(send).toHaveBeenCalledWith({ type: 'readDirect', userId: 'ben' })

    // Arrived over the socket: this conversation's, not another one's
    rerender({ load, talkTo: 'ben', live: [msg(5, 'ben', 'amy', 'see you'), msg(6, 'ben', 'amy', 'new one'), msg(7, 'cat', 'amy', 'not here')] })
    expect(screen.getByText('new one')).toBeInTheDocument()
    expect(screen.queryByText('not here')).toBeNull()
    expect(screen.getAllByText('see you')).toHaveLength(1)

    await userEvent.click(screen.getByRole('button', { name: '載入較早的訊息' }))
    expect(await screen.findByText('first')).toBeInTheDocument()
    expect(load).toHaveBeenLastCalledWith('ben', 4)
    await waitFor(() => expect(screen.queryByRole('button', { name: '載入較早的訊息' })).toBeNull())

    await userEvent.type(screen.getByRole('textbox', { name: '輸入私訊，Enter 送出' }), 'ok{Enter}')
    expect(send).toHaveBeenLastCalledWith({ type: 'sendDirect', to: 'ben', text: 'ok' })
  })

  it('names a member with no conversation yet, and cannot write to a member one blocked', async () => {
    show({ talkTo: 'zoe', blocked: ['zoe'] })
    expect(await screen.findByText('還沒有訊息，打聲招呼吧')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: '與 zoe 的私訊' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('解除封鎖後才能傳私訊')
    expect(screen.getByRole('textbox')).toBeDisabled()
  })
})

describe('PeopleList envelope', () => {
  const person = (id: string): MemberStatus => ({ id, username: id, online: true, tableNumber: null, seat: null })
  const lobby: LobbyView = { online: [], members: [person('amy'), person('ben')], tables: [], myTableId: null, friends: [], blocked: [] }

  it('opens the conversation with a member, and is only there when the page has messages', async () => {
    const onMessage = vi.fn()
    const { rerender } = render(
      <PreferencesProvider>
        <MemoryRouter>
          <PeopleList lobby={lobby} userId="amy" send={vi.fn()} onMessage={onMessage} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('button', { name: '傳私訊給 amy' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '傳私訊給 ben' }))
    expect(onMessage).toHaveBeenCalledWith('ben')

    rerender(
      <PreferencesProvider>
        <MemoryRouter>
          <PeopleList lobby={lobby} userId="amy" send={vi.fn()} />
        </MemoryRouter>
      </PreferencesProvider>,
    )
    expect(screen.queryByRole('button', { name: '傳私訊給 ben' })).toBeNull()
  })
})
