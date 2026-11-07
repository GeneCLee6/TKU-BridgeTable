import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PreferencesProvider, usePreferences } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/**
 * Only the landing page is in English for someone who has not chosen a language (社長 2026-11-07,
 * `unchosenLang`, which `App.tsx` passes on that page alone). Every other page keeps detecting the
 * browser's language, and what the landing page shows must never be saved as the viewer's language.
 */

const KEY = 'tku-bridge-table:prefs'

function Probe() {
  const { lang, t, set } = usePreferences()
  return (
    <>
      <output>{lang}</output>
      <p>{t.landing.headline}</p>
      <button onClick={() => set({ lang: 'ja' })}>ja</button>
    </>
  )
}

const page = (landing: boolean) => (
  <PreferencesProvider unchosenLang={landing ? 'en' : undefined}>
    <Probe />
  </PreferencesProvider>
)

const saved = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as { lang?: string; langChosen?: boolean }
const browserSpeaks = (language: string) => vi.spyOn(navigator, 'language', 'get').mockReturnValue(language)

describe('the landing page’s language', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it.each(['zh-TW', 'zh-CN', 'ja-JP', 'ko-KR', 'vi-VN', 'fr-FR'])('is English in a %s browser that has chosen nothing', (language) => {
    browserSpeaks(language)
    render(page(true))
    expect(screen.getByRole('status')).toHaveTextContent('en')
    expect(screen.getByText(STRINGS.en.landing.headline)).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('does not save English as the viewer’s language: the next page detects as before', () => {
    browserSpeaks('zh-TW')
    const { unmount } = render(page(true))
    expect(saved()).toMatchObject({ lang: 'zh', langChosen: false })
    unmount()
    render(page(false))
    expect(screen.getByRole('status')).toHaveTextContent('zh')
    expect(document.documentElement.lang).toBe('zh-Hant-TW')
  })

  it('switching on it shows that language at once and everywhere after', async () => {
    browserSpeaks('zh-TW')
    const { unmount } = render(page(true))
    await userEvent.click(screen.getByRole('button', { name: 'ja' }))
    expect(screen.getByRole('status')).toHaveTextContent('ja')
    expect(saved()).toMatchObject({ lang: 'ja', langChosen: true })
    unmount()
    render(page(true))
    expect(screen.getByRole('status')).toHaveTextContent('ja')
  })

  it('a language saved before the flag existed counts as chosen only if it is not the browser’s', () => {
    browserSpeaks('zh-TW')
    localStorage.setItem(KEY, JSON.stringify({ lang: 'ko' }))
    const chosen = render(page(true))
    expect(screen.getByRole('status')).toHaveTextContent('ko')
    chosen.unmount()

    // Written by the first visit, not picked: the landing page is English, the app stays as it was
    localStorage.setItem(KEY, JSON.stringify({ lang: 'zh' }))
    const detected = render(page(true))
    expect(screen.getByRole('status')).toHaveTextContent('en')
    detected.unmount()
    render(page(false))
    expect(screen.getByRole('status')).toHaveTextContent('zh')
  })
})

describe('members’ language detection is unchanged', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it.each([
    ['zh-TW', 'zh'],
    ['zh-HK', 'zh'],
    ['zh-CN', 'zh-Hans'],
    ['ja-JP', 'ja'],
    ['ko-KR', 'ko'],
    ['vi-VN', 'vi'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
  ])('a %s browser sees %s', (language, lang) => {
    browserSpeaks(language)
    render(page(false))
    expect(screen.getByRole('status')).toHaveTextContent(lang)
    // Written on the first visit, as it always was
    expect(saved().lang).toBe(lang)
  })

  it('a remembered language wins over the browser’s, chosen or not', () => {
    browserSpeaks('zh-TW')
    localStorage.setItem(KEY, JSON.stringify({ lang: 'vi' }))
    render(page(false))
    expect(screen.getByRole('status')).toHaveTextContent('vi')
  })
})
