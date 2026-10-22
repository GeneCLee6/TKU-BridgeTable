import { useSyncExternalStore } from 'react'

/**
 * The site as a phone app (a PWA): the service worker that makes it installable, and the browser's
 * install offer. Chrome and Edge on Android and computers offer to install with an event the page
 * can keep and use from its own button; iPhones and iPads have no such event, so the page explains
 * Safari's "Add to Home Screen" instead.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let offer: InstallPromptEvent | null = null
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())

/** Call once at start-up: registers the service worker and keeps the install offer for later */
export function setUpApp() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    offer = event as InstallPromptEvent
    changed()
  })
  window.addEventListener('appinstalled', () => {
    offer = null
    changed()
  })
  // Only the built site: a service worker would get in the way of the dev server
  if (import.meta.env.PROD && 'serviceWorker' in navigator)
    window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}

/** Whether the page is already running as the installed app */
export function isStandalone() {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

export const isAppleMobile = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

/** The browser's install offer, if it made one; `install` shows its dialog */
export function useInstallOffer() {
  const available = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => offer !== null,
    () => false,
  )
  const install = async () => {
    if (!offer) return
    await offer.prompt()
    await offer.userChoice.catch(() => undefined)
    offer = null
    changed()
  }
  return { available, install }
}
