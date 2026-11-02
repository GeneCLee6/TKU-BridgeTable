import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PushCard } from '../../src/components/PushCard.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import type { Me } from '../../shared/protocol.ts'
import { NOTIFICATION_KINDS } from '../../shared/protocol.ts'
import { PUSH_GROUPS, pushDeviceId, type PushKinds, type PushView } from '../../shared/push.ts'

type Answer = { status: number; body: unknown }

/** Answers the API calls; a list of answers is used in order. Records what was sent */
function stubApi(routes: Record<string, Answer | Answer[]>) {
  const sent: { path: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const listed = routes[path]
      const route = (Array.isArray(listed) ? (listed.length > 1 ? listed.shift() : listed[0]) : listed) ?? {
        status: 401,
        body: { error: '請先登入', code: 'signInFirst', params: {} },
      }
      return new Response(JSON.stringify(route.body), { status: route.status })
    }),
  )
  return sent
}

/** A browser that can push: a service worker whose push manager subscribes at once, and permission granted */
function stubBrowserPush(endpoint: string) {
  const subscription = {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => true),
  }
  let current: typeof subscription | null = null
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => (current = subscription)),
  }
  const registration = { pushManager }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  })
  vi.stubGlobal('PushManager', function PushManager() {})
  const requestPermission = vi.fn(async () => 'granted')
  vi.stubGlobal('Notification', { permission: 'default', requestPermission })
  return { pushManager, subscription, requestPermission }
}

const wrap = (children: ReactNode) =>
  render(
    <PreferencesProvider>
      <AuthProvider>{children}</AuthProvider>
    </PreferencesProvider>,
  )

const amy: Me = { id: 'm1', username: 'amy', admin: false, permissions: [] }
const allOn = () => Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, k !== 'friendOnline'])) as PushKinds
const view = (more: Partial<PushView> = {}): PushView => ({ enabled: true, publicKey: 'BKey', devices: [], kinds: allOn(), ...more })
const ME = { '/api/me': { status: 200, body: { user: amy } } }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('push notifications on My account (e1-t28)', () => {
  it('shows nothing when the club has no push', async () => {
    const sent = stubApi({ ...ME, '/api/push': { status: 200, body: { enabled: false, devices: [], kinds: allOn() } } })
    wrap(<PushCard />)
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/push')).toBe(true))
    expect(screen.queryByText('推播通知')).toBeNull()
  })

  it('turns push on for this device: permission, subscription, then the server', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc'
    const browser = stubBrowserPush(endpoint)
    const id = await pushDeviceId(endpoint)
    const sent = stubApi({
      ...ME,
      '/api/push': [{ status: 200, body: view() }, { status: 200, body: view({ devices: [{ id, name: 'Chrome · Android', createdAt: 1 }] }) }],
      '/api/push/subscribe': { status: 200, body: view({ devices: [{ id, name: 'Chrome · Android', createdAt: 1 }] }) },
    })
    wrap(<PushCard />)
    expect(await screen.findByText('這台裝置還沒開啟推播。')).toBeInTheDocument()
    expect(screen.getByText('還沒有裝置開啟推播。')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '在這台裝置開啟推播' }))
    expect(await screen.findByText('這台裝置已開啟推播。')).toBeInTheDocument()
    expect(browser.requestPermission).toHaveBeenCalled()
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }))
    expect(sent.find((s) => s.path === '/api/push/subscribe')!.body).toEqual({ endpoint, keys: { p256dh: 'P', auth: 'A' }, lang: 'zh' })
    expect(screen.getByText('這台裝置')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在這台裝置關閉' })).toBeInTheDocument()
  })

  it('says why when the member does not allow notifications', async () => {
    const browser = stubBrowserPush('https://fcm.googleapis.com/fcm/send/x')
    browser.requestPermission.mockResolvedValue('denied')
    stubApi({ ...ME, '/api/push': { status: 200, body: view() } })
    wrap(<PushCard />)
    await userEvent.click(await screen.findByRole('button', { name: '在這台裝置開啟推播' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('封鎖了本站的通知')
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('explains when this browser cannot push, and still lists and removes other devices', async () => {
    const sent = stubApi({
      ...ME,
      '/api/push': { status: 200, body: view({ devices: [{ id: 'd1', name: 'Safari · iPhone', createdAt: 1 }] }) },
      '/api/push/unsubscribe': { status: 200, body: view() },
    })
    wrap(<PushCard />)
    expect(await screen.findByText('這個瀏覽器不支援推播通知。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '在這台裝置開啟推播' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '移除 Safari · iPhone' }))
    expect(await screen.findByText('還沒有裝置開啟推播。')).toBeInTheDocument()
    expect(sent.find((s) => s.path === '/api/push/unsubscribe')!.body).toEqual({ id: 'd1' })
  })

  it('switches every kind of a group, and shows the admin group only to admins', async () => {
    const off = { ...allOn(), ...Object.fromEntries(PUSH_GROUPS.matches.map((k) => [k, false])) }
    const sent = stubApi({
      ...ME,
      '/api/push': { status: 200, body: view() },
      '/api/push/kinds': { status: 200, body: view({ kinds: off }) },
    })
    wrap(<PushCard />)
    const box = await screen.findByRole('checkbox', { name: '隊制賽' })
    expect(box).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /^管理/ })).toBeNull()
    await userEvent.click(box)
    await vi.waitFor(() => expect(screen.getByRole('checkbox', { name: '隊制賽' })).not.toBeChecked())
    expect(sent.find((s) => s.path === '/api/push/kinds')!.body).toEqual({
      kinds: Object.fromEntries(PUSH_GROUPS.matches.map((k) => [k, false])),
    })
  })

  it('sends a test push to the devices', async () => {
    const sent = stubApi({
      ...ME,
      '/api/push': { status: 200, body: view({ devices: [{ id: 'd1', name: 'Chrome · Windows', createdAt: 1 }] }) },
      '/api/push/test': { status: 200, body: { devices: 1 } },
    })
    wrap(<PushCard />)
    await userEvent.click(await screen.findByRole('button', { name: '傳送測試通知' }))
    await vi.waitFor(() => expect(sent.some((s) => s.path === '/api/push/test')).toBe(true))
  })
})
