import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '../../shared/messages.ts'
import { App } from '../../src/App.tsx'
import { PageBoundary, PartBoundary, PartFailedNote, RootBoundary } from '../../src/components/ErrorBoundary.tsx'
import { setUpErrorReporting } from '../../src/lib/errorReport.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/**
 * A render error must not blank the app: a child throws, the rest stays, and the error goes the
 * client-error path. The same against a production build: tests/visual/production.spec.ts
 */

const mocks = vi.hoisted(() => ({
  broken: new Set<string>(),
  user: { id: 'amy', username: 'amy', admin: false, permissions: [] } as unknown,
}))

const part = (name: string, text: string) => {
  if (mocks.broken.has(name)) throw new Error(`${name} broke`)
  return <div>{text}</div>
}

vi.mock('../../src/pages/LobbyPage.tsx', () => ({ LobbyPage: () => part('lobby', '大廳的內容') }))
vi.mock('../../src/components/NoticeBanners.tsx', () => ({ NoticeBanners: () => part('banners', '公告的內容') }))
vi.mock('../../src/components/NotificationBell.tsx', () => ({ NotificationBell: () => part('bell', '鈴鐺') }))
vi.mock('../../src/state/AuthContext.tsx', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ user: mocks.user, logout: vi.fn(), missingClub: false }),
  useFeature: () => false,
}))
vi.mock('../../src/state/ClubContext.tsx', () => ({
  ClubProvider: ({ children }: { children: React.ReactNode }) => children,
  useClub: () => ({
    status: 'open',
    lobby: null,
    table: null,
    error: null,
    notifications: { items: [], unread: 0 },
    directLive: null,
    matchLive: null,
    send: vi.fn(),
    dismissError: vi.fn(),
  }),
  useLobby: () => null,
}))

function Bomb({ message = 'kaboom' }: { message?: string }): never {
  throw new Error(message)
}

/** The reports that went to `/api/client-errors` */
function reports() {
  const sent: Record<string, string>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/client-errors') sent.push(JSON.parse(String(init?.body)))
      return new Response('{}', { status: 200 })
    }),
  )
  return sent
}

const zh = STRINGS.zh.errorBoundary

const show = (ui: React.ReactNode, path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <PreferencesProvider>{ui}</PreferencesProvider>
    </MemoryRouter>,
  )

beforeEach(() => {
  mocks.broken.clear()
  // React writes every caught error to the console; here they are the point
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // A fresh page load as far as the reports' limits go
  setUpErrorReporting()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the page boundary', () => {
  it('keeps what is outside it, and says so with a retry that works', async () => {
    reports()
    function Flaky() {
      if (mocks.broken.has('flaky')) throw new Error('flaky broke')
      return <div>頁面內容</div>
    }
    mocks.broken.add('flaky')
    show(
      <>
        <header>頁首</header>
        <PageBoundary name="page">
          <Flaky />
        </PageBoundary>
      </>,
    )
    expect(screen.getByText('頁首')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(zh.title)
    expect(screen.getByRole('link', { name: zh.home })).toHaveAttribute('href', '/')

    // Still broken: the message again, not a blank page
    await userEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(screen.getByRole('alert')).toBeInTheDocument()

    mocks.broken.delete('flaky')
    await userEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(screen.getByText('頁面內容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('clears when the member goes to another page', async () => {
    reports()
    show(
      <>
        <Link to="/other">別頁</Link>
        <PageBoundary name="page">
          <Routes>
            <Route path="/" element={<Bomb />} />
            <Route path="/other" element={<div>別頁內容</div>} />
          </Routes>
        </PageBoundary>
      </>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: '別頁' }))
    expect(screen.getByText('別頁內容')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('catches `throw null` too, which has no error to keep', () => {
    const sent = reports()
    function Thrower(): never {
      throw null
    }
    show(
      <PageBoundary name="page">
        <Thrower />
      </PageBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(sent[0]).toMatchObject({ message: 'null', source: 'boundary:page' })
  })
})

describe('a part beside the page', () => {
  it('goes alone, and its siblings stay', () => {
    reports()
    const { container } = show(
      <>
        <PartBoundary name="banner">
          <span>橫幅</span>
          <Bomb />
        </PartBoundary>
        <div>頁面內容</div>
      </>,
    )
    expect(screen.queryByText('橫幅')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container).toHaveTextContent('頁面內容')
  })

  it('catches an effect that throws', () => {
    reports()
    function BadEffect() {
      useEffect(() => {
        throw new Error('effect broke')
      }, [])
      return <span>聲音</span>
    }
    show(
      <>
        <PartBoundary name="sounds">
          <BadEffect />
        </PartBoundary>
        <div>頁面內容</div>
      </>,
    )
    expect(screen.queryByText('聲音')).toBeNull()
    expect(screen.getByText('頁面內容')).toBeInTheDocument()
  })

  it('says so when asked to, and comes back with a new reset key', () => {
    reports()
    const part = (key: string, ok: boolean) => (
      <PreferencesProvider>
        <MemoryRouter>
          <PartBoundary name="tab" resetKey={key} fallback={<PartFailedNote />}>
            {ok ? <div>分頁內容</div> : <Bomb />}
          </PartBoundary>
        </MemoryRouter>
      </PreferencesProvider>
    )
    const { rerender } = render(part('chat', false))
    expect(screen.getByRole('status')).toHaveTextContent(zh.part)
    rerender(part('people', true))
    expect(screen.getByText('分頁內容')).toBeInTheDocument()
  })

  it('tells whoever holds it, so a dialog can close and open again', () => {
    reports()
    const onFail = vi.fn()
    show(
      <PartBoundary name="dialog" onFail={onFail}>
        <Bomb />
      </PartBoundary>,
    )
    expect(onFail).toHaveBeenCalledTimes(1)
  })
})

describe('the last resort', () => {
  it('leaves words in the root when nothing else is left, in the language chosen', () => {
    reports()
    localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'ja' }))
    try {
      const { container } = render(
        <RootBoundary>
          <Bomb />
        </RootBoundary>,
      )
      expect(container).not.toBeEmptyDOMElement()
      expect(screen.getByRole('alert')).toHaveTextContent(STRINGS.ja.errorBoundary.title)
      expect(screen.getByRole('button', { name: STRINGS.ja.errorBoundary.reload })).toBeInTheDocument()
    } finally {
      localStorage.removeItem('tku-bridge-table:prefs')
    }
  })
})

describe('reporting', () => {
  it('sends what a boundary caught through the client-error path, once, without personal data', async () => {
    const sent = reports()
    show(
      <>
        <PartBoundary name="bell">
          <Bomb message="cannot read amy@example.com" />
        </PartBoundary>
        <PartBoundary name="bell-again">
          <Bomb message="cannot read amy@example.com" />
        </PartBoundary>
        <PageBoundary name="page">
          <Bomb message="another" />
        </PageBoundary>
      </>,
    )
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[0]).toMatchObject({ kind: 'error', message: 'Error: cannot read <email>', source: 'boundary:bell' })
    expect(sent[1]).toMatchObject({ message: 'Error: another', source: 'boundary:page' })
    for (const report of sent) expect(report.page).toBe(window.location.pathname)
  })

  it('never lets a failed report cause another error', () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('no network')
    })
    show(
      <PartBoundary name="bell">
        <Bomb />
      </PartBoundary>,
    )
    expect(document.body).toBeInTheDocument()
  })
})

it('has the words in six languages', () => {
  for (const lang of LANGS) {
    const words = STRINGS[lang].errorBoundary
    for (const key of ['title', 'hint', 'retry', 'home', 'reload', 'part'] as const) expect(words[key], `${lang} ${key}`).toBeTruthy()
  }
})

describe('the whole app', () => {
  const app = (path = '/') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    )

  beforeEach(() => {
    reports()
  })

  it('shows the page when nothing is wrong', () => {
    app()
    expect(screen.getByText('大廳的內容')).toBeInTheDocument()
    expect(screen.getByText('公告的內容')).toBeInTheDocument()
  })

  it('keeps the header and the banners when the page fails', () => {
    mocks.broken.add('lobby')
    app()
    expect(screen.getByRole('alert')).toHaveTextContent(zh.title)
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: STRINGS.zh.navHistory })).toBeInTheDocument()
    expect(screen.getByText('公告的內容')).toBeInTheDocument()
  })

  it('keeps the page and the header when the banners fail', () => {
    mocks.broken.add('banners')
    app()
    expect(screen.getByText('大廳的內容')).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the rest of the header and the page when the bell fails', () => {
    mocks.broken.add('bell')
    app()
    expect(screen.queryByText('鈴鐺')).toBeNull()
    expect(screen.getByRole('link', { name: STRINGS.zh.navHistory })).toBeInTheDocument()
    expect(screen.getByText('大廳的內容')).toBeInTheDocument()
  })
})
