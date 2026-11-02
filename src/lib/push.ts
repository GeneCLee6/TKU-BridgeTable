import { pushDeviceId } from '../../shared/push.ts'
import { api } from './api.ts'
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

/**
 * Asks for permission, subscribes this browser with the club's key and gives the server the
 * subscription. False when the member said no. An old subscription (another key) is dropped first
 */
export async function subscribeThisDevice(publicKey: string, lang: string): Promise<boolean> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const reg = await registration()
  const old = await reg.pushManager.getSubscription()
  if (old) await old.unsubscribe().catch(() => false)
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await api.push.subscribe(subscription.toJSON(), lang)
  return true
}

/** Stops this browser's pushes: the server forgets the device and the browser drops the subscription */
export async function unsubscribeThisDevice(): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.push.unsubscribe(await pushDeviceId(subscription.endpoint)).catch(() => undefined)
  await subscription.unsubscribe().catch(() => false)
}

/**
 * Signing out on this browser: the next person to sign in here must not get this member's pushes.
 * Best effort and quick, before the session ends (the server needs it to know whose device it was)
 */
export async function forgetPushOnSignOut(): Promise<void> {
  try {
    await Promise.race([unsubscribeThisDevice(), new Promise((resolve) => setTimeout(resolve, 1500))])
  } catch {
    // Signing out goes on regardless
  }
}
