import { CLUB_HEADER, DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { pushDeviceId } from '../../shared/push.ts'
import { api } from './api.ts'
import { currentClub } from './club.ts'
import { isAppleMobile, isStandalone } from './pwa.ts'

/**
 * This browser's push subscription (e1-t28, ARCHITECTURE.md §5.4). The service worker (`/sw.js`)
 * shows what arrives; this file asks for permission, subscribes with the club's VAPID key and
 * tells the server, or undoes that.
 */

/** Whether this browser can get pushes here: yes, not at all, only from the home screen (iPhone, iPad), or the member blocked notifications */
export type PushSupport = 'ok' | 'unsupported' | 'homeScreen' | 'denied'

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported'
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  // Safari on iOS has push only for a site added to the home screen and opened from there (iOS 16.4+)
  if (isAppleMobile() && !isStandalone()) return 'homeScreen'
  if (!capable) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

/** The service worker, registered now if the page has not yet (it registers on load in the built site) */
async function registration(): Promise<ServiceWorkerRegistration> {
  const found = await navigator.serviceWorker.getRegistration()
  if (!found) await navigator.serviceWorker.register('/sw.js')
  return navigator.serviceWorker.ready
}

/** This browser's subscription, if it has one; never registers a service worker */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null
  const found = await navigator.serviceWorker.getRegistration()
  return (await found?.pushManager.getSubscription()) ?? null
}

/** The id the server gives this browser's device, or null when it has no subscription */
export async function thisDeviceId(): Promise<string | null> {
  const subscription = await currentSubscription().catch(() => null)
  return subscription ? pushDeviceId(subscription.endpoint) : null
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── Which clubs use this browser's subscription ────────────────────────────────────────────────

/**
 * A browser has one push subscription, but each club keeps its own devices (its `push:<userId>`):
 * the same subscription may be registered with several clubs this browser is signed in to
 * (ARCHITECTURE.md §5.4「每個社團各自訂閱」). The clubs are kept here, for the whole site (not per
 * club), and copied where the service worker can read them when the browser renews the
 * subscription (`public/sw.js`). The browser drops its subscription only once no club uses it
 */
export const PUSH_CLUBS_KEY = 'tbt-push-clubs'
const SW_CACHE = 'tku-bridge-table-push'
const SW_KEY = '/push-clubs'

/** The clubs this browser registered its subscription with; null when it never kept any (before clubs) */
function storedClubs(): string[] | null {
  try {
    const raw = localStorage.getItem(PUSH_CLUBS_KEY)
    if (raw === null) return null
    const list: unknown = JSON.parse(raw)
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return null
  }
}

export function pushClubs(): string[] {
  return storedClubs() ?? []
}

function savePushClubs(clubs: string[]) {
  const list = [...new Set(clubs)]
  try {
    localStorage.setItem(PUSH_CLUBS_KEY, JSON.stringify(list))
  } catch {
    // Private mode and the like: the list lives as long as the page
  }
  if (typeof caches === 'undefined') return
  void caches
    .open(SW_CACHE)
    .then((cache) => cache.put(SW_KEY, new Response(JSON.stringify(list), { headers: { 'Content-Type': 'application/json' } })))
    .catch(() => undefined)
}

/**
 * The clubs using a subscription the browser already has. One made before this list was kept was
 * 淡江's (the only club then), so it counts as 淡江's
 */
function clubsOf(existing: PushSubscription | null): string[] {
  const stored = storedClubs()
  return stored ?? (existing ? [DEFAULT_CLUB_ID] : [])
}

const sameKey = (subscription: PushSubscription, key: Uint8Array) => {
  const own = subscription.options?.applicationServerKey
  if (!own) return false
  const bytes = new Uint8Array(own)
  return bytes.length === key.length && bytes.every((b, i) => b === key[i])
}

/** Registers a new subscription with another club this browser uses (its own sign-in cookie decides); false when it would not */
async function registerWith(clubId: string, subscription: PushSubscription, lang: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (clubId !== DEFAULT_CLUB_ID) headers[CLUB_HEADER] = clubId
  try {
    const response = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ ...subscription.toJSON(), lang }),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Asks for permission, subscribes this browser with the club's key and gives this club the
 * subscription. False when the member said no. A subscription the browser already has with the
 * same key (another club's: the key is the site's) is used as it is; one with another key is
 * replaced, and the new one given to the other clubs that used the old one
 */
export async function subscribeThisDevice(publicKey: string, lang: string): Promise<boolean> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const reg = await registration()
  const key = keyBytes(publicKey)
  const old = await reg.pushManager.getSubscription()
  const others = clubsOf(old).filter((id) => id !== currentClub())
  let subscription = old && sameKey(old, key) ? old : null
  let kept = others
  if (!subscription) {
    if (old) await old.unsubscribe().catch(() => false)
    subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    const fresh = subscription
    const answers = old ? await Promise.all(others.map((id) => registerWith(id, fresh, lang))) : []
    kept = old ? others.filter((_, i) => answers[i]) : []
  }
  await api.push.subscribe(subscription.toJSON(), lang)
  savePushClubs([...kept, currentClub()])
  return true
}

/** This club no longer uses this browser's subscription (its device was removed here); the browser keeps it for the others */
export function forgetThisClub() {
  const stored = storedClubs()
  if (stored) savePushClubs(stored.filter((id) => id !== currentClub()))
}

/**
 * Stops this club's pushes on this browser: the club forgets the device; the browser drops the
 * subscription only when no other club on this browser still uses it
 */
export async function unsubscribeThisDevice(): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  const others = clubsOf(subscription).filter((id) => id !== currentClub())
  await api.push.unsubscribe(await pushDeviceId(subscription.endpoint)).catch(() => undefined)
  savePushClubs(others)
  if (others.length === 0) await subscription.unsubscribe().catch(() => false)
}

/**
 * Signing out of this club on this browser: the next person to sign in to it here must not get
 * this member's pushes; the other clubs this browser is signed in to keep theirs. Best effort and
 * quick, before the session ends (the server needs it to know whose device it was)
 */
export async function forgetPushOnSignOut(): Promise<void> {
  try {
    await Promise.race([unsubscribeThisDevice(), new Promise((resolve) => setTimeout(resolve, 1500))])
  } catch {
    // Signing out goes on regardless
  }
}
