import { useEffect } from 'react'

/**
 * Keeps the page behind a dialog from scrolling while the dialog is open (社長 2026-10-27: on a
 * phone, swiping a dialog moved the page). `overflow: hidden` alone does not stop iOS Safari, so
 * the body is pinned with `position: fixed` at the current scroll position and put back when the
 * last lock goes. Locks are counted, so a dialog opened over another keeps the page still until
 * both close (and StrictMode's second run of the effect does no harm). The dialog's own scroll
 * areas use `overscroll-behavior: contain` (see `Modal.tsx`), so a swipe that reaches the end of
 * one does not pass on to the page.
 */

let locks = 0
let saved: { y: number; body: string | null; html: string | null } | null = null

function restore(el: HTMLElement, style: string | null) {
  if (style) el.setAttribute('style', style)
  else el.removeAttribute('style')
}

function lock() {
  locks += 1
  if (locks > 1) return
  const { body, documentElement: html } = document
  const y = window.scrollY
  // The scroll bar goes away with the page's scrolling; keep its room so nothing shifts sideways
  const bar = window.innerWidth - html.clientWidth
  saved = { y, body: body.getAttribute('style'), html: html.getAttribute('style') }
  html.style.overflow = 'hidden'
  body.style.position = 'fixed'
  body.style.top = `${-y}px`
  body.style.left = '0'
  body.style.right = '0'
  body.style.overflow = 'hidden'
  if (bar > 0) body.style.paddingRight = `${bar}px`
}

function unlock() {
  locks = Math.max(0, locks - 1)
  if (locks > 0 || !saved) return
  const { y } = saved
  restore(document.body, saved.body)
  restore(document.documentElement, saved.html)
  saved = null
  if (y) window.scrollTo(0, y)
}

/** Locks the page's scrolling while `active` (by default, while the component is mounted) */
export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) return
    lock()
    return unlock
  }, [active])
}
