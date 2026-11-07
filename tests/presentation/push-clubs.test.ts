import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkClubManifest, setClubFromPath } from '../../src/lib/club.ts'
import { forgetPushOnSignOut, PUSH_CLUBS_KEY, pushClubs, subscribeThisDevice } from '../../src/lib/push.ts'

/**
 * One browser, several clubs (ARCHITECTURE.md §5.4「每個社團各自訂閱」): the browser has one push
 * subscription, registered with each club it turned push on in; signing out of one club removes
 * that club's registration only, and the browser drops the subscription once no club uses it.
 */

const KEY = 'BKey'
const OTHER_KEY = 'BNew'
const bytes = (key: string) => Uint8Array.from(atob(key), (c) => c.charCodeAt(0)).buffer

interface Call {
  path: string
  club: string | null
  body: unknown
}

function stubFetch() {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, club: new Headers(init?.headers).get('X-Club-Id'), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({ enabled: true, devices: [], kinds: {} }), { status: 200 })
    }),
  )
  return calls
}

/** A browser that can push; `existing` is a subscription it already has (with that key) */
function stubBrowser(existing?: { endpoint: string; key: string }) {
  const make = (endpoint: string, key: string) => ({
    endpoint,
    options: { applicationServerKey: bytes(key) },
    toJSON: () => ({ endpoint, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => true),
  })
  let current: ReturnType<typeof make> | null = existing ? make(existing.endpoint, existing.key) : null
  const made: ReturnType<typeof make>[] = current ? [current] : []
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (options: { applicationServerKey: Uint8Array }) => {
      const key = btoa(String.fromCharCode(...options.applicationServerKey))
      current = make(`https://fcm.googleapis.com/fcm/send/${made.length}`, key)
      made.push(current)
      return current
    }),
  }
  const registration = { pushManager }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: vi.fn(async () => registration), register: vi.fn(async () => registration), ready: Promise.resolve(registration) },
  })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') })
  return { pushManager, made }
}

beforeEach(() => {
  localStorage.removeItem(PUSH_CLUBS_KEY)
})

afterEach(() => {
  setClubFromPath('/')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (navigator as { serviceWorker?: unknown }).serviceWorker
})

describe('push subscriptions per club', () => {
  it('registers one subscription with two clubs and keeps it for the other club on signing out of one', async () => {
    const browser = stubBrowser()
    const calls = stubFetch()

    setClubFromPath('/')
    expect(await subscribeThisDevice(KEY, 'zh')).toBe(true)
    setClubFromPath('/c/ntu/account')
    expect(await subscribeThisDevice(KEY, 'zh')).toBe(true)
    // The same key: the browser's subscription is used again, not replaced
    expect(browser.pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.path === '/api/push/subscribe').map((c) => c.club)).toEqual([null, 'ntu'])
    expect(pushClubs()).toEqual(['tku', 'ntu'])

    // Signing out of ntu: ntu forgets the device, 淡江 keeps getting pushes
    await forgetPushOnSignOut()
    expect(calls.at(-1)).toMatchObject({ path: '/api/push/unsubscribe', club: 'ntu' })
    expect(browser.made[0].unsubscribe).not.toHaveBeenCalled()
    expect(pushClubs()).toEqual(['tku'])

    // Signing out of 淡江 too: no club uses it, the browser drops it
    setClubFromPath('/')
    await forgetPushOnSignOut()
    expect(calls.at(-1)).toMatchObject({ path: '/api/push/unsubscribe', club: null })
    expect(browser.made[0].unsubscribe).toHaveBeenCalled()
    expect(pushClubs()).toEqual([])
  })

  it('counts a subscription from before clubs as 淡江’s', async () => {
    const browser = stubBrowser({ endpoint: 'https://fcm.googleapis.com/fcm/send/old', key: KEY })
    stubFetch()
    setClubFromPath('/c/ntu/')
    await subscribeThisDevice(KEY, 'zh')
    expect(pushClubs()).toEqual(['tku', 'ntu'])
    await forgetPushOnSignOut()
    expect(browser.made[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('gives a replaced subscription (a new key) to the other clubs that used the old one', async () => {
    const browser = stubBrowser({ endpoint: 'https://fcm.googleapis.com/fcm/send/old', key: KEY })
    const calls = stubFetch()
    localStorage.setItem(PUSH_CLUBS_KEY, JSON.stringify(['tku']))
    setClubFromPath('/c/ntu/')
    await subscribeThisDevice(OTHER_KEY, 'en')
    expect(browser.made[0].unsubscribe).toHaveBeenCalled()
    const subscribed = calls.filter((c) => c.path === '/api/push/subscribe')
    expect(subscribed.map((c) => c.club)).toEqual([null, 'ntu'])
    expect(subscribed[0].body).toMatchObject({ endpoint: browser.made[1].endpoint, lang: 'en' })
    expect(pushClubs()).toEqual(['tku', 'ntu'])
  })
})

describe('home-screen app per club', () => {
  const head = () => {
    document.head.innerHTML =
      '<link rel="manifest" href="/manifest.webmanifest" /><meta name="apple-mobile-web-app-title" content="Overtrick" />'
  }

  it('links another club’s own manifest and leaves 淡江’s alone', () => {
    head()
    setClubFromPath('/')
    linkClubManifest()
    expect(document.querySelector('link[rel="manifest"]')!.getAttribute('href')).toBe('/manifest.webmanifest')
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')).not.toBeNull()

    setClubFromPath('/c/ntu/table/t1')
    linkClubManifest()
    expect(document.querySelector('link[rel="manifest"]')!.getAttribute('href')).toBe('/c/ntu/manifest.webmanifest')
    expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')).toBeNull()
  })
})
