import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { Lang } from '../../shared/messages.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { FieldError } from './ui.tsx'

/**
 * Cloudflare Turnstile's widget on 申請加入 (e1-t33, worker/turnstile.ts). Shown only when the
 * Worker hands out a site key; the script comes from challenges.cloudflare.com, which the page's
 * CSP lets in for this (docs/SECURITY.md §2). Each token is good for one try: bump `resetKey`
 * after every answer from the server and the widget makes a new one.
 */

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  reset: (widgetId: string) => void
  remove: (widgetId: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

/** Turnstile's own language codes for the site's six */
const TURNSTILE_LANG: Record<Lang, string> = { zh: 'zh-tw', 'zh-Hans': 'zh-cn', en: 'en', vi: 'vi', ja: 'ja', ko: 'ko' }

let loading: Promise<TurnstileApi> | null = null

/** Loads the script once for the page */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')))
    script.onerror = () => {
      loading = null
      script.remove()
      reject(new Error('turnstile'))
    }
    document.head.appendChild(script)
  })
  return loading
}

const Box = styled.div`
  min-height: 65px;
`

export function Turnstile({ siteKey, resetKey, onToken }: { siteKey: string; resetKey: number; onToken: (token: string) => void }) {
  const { t, lang, mode } = usePreferences()
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const report = useRef(onToken)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    report.current = onToken
  }, [onToken])

  useEffect(() => {
    let cancelled = false
    loadTurnstile().then(
      (api) => {
        if (cancelled || !box.current) return
        widget.current = api.render(box.current, {
          sitekey: siteKey,
          language: TURNSTILE_LANG[lang],
          theme: mode === 'dark' ? 'dark' : 'light',
          callback: (token: string) => report.current(token),
          'expired-callback': () => report.current(''),
          'error-callback': () => report.current(''),
        })
      },
      () => !cancelled && setFailed(true),
    )
    return () => {
      // StrictMode runs this twice in development: the first widget goes before the second is drawn
      cancelled = true
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [siteKey, lang, mode])

  useEffect(() => {
    if (resetKey && widget.current) {
      report.current('')
      window.turnstile?.reset(widget.current)
    }
  }, [resetKey])

  return (
    <div role="group" aria-label={t.captchaLabel}>
      <Box ref={box} />
      {failed && <FieldError role="alert">{t.captchaLoadFailed}</FieldError>}
    </div>
  )
}
