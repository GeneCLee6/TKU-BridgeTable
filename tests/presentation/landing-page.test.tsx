import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { AppHeader } from '../../src/components/AppHeader.tsx'
import { homePath, setClubFromPath } from '../../src/lib/club.ts'
import { LandingPage } from '../../src/pages/LandingPage.tsx'
import * as auth from '../../src/state/AuthContext.tsx'
import * as club from '../../src/state/ClubContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

/** The landing page's way back to a club, and how the header shows the club and the platform (DESIGN.md §6) */

const l = STRINGS.en.landing
const signedIn = (user: Partial<Me> | null) =>
  vi.spyOn(auth, 'useAuth').mockReturnValue({ user: user as Me | null, login: vi.fn(), register: vi.fn(), logout: vi.fn(), refresh: vi.fn(), missingClub: false })

const show = (ui: React.ReactNode, path: string) =>
  render(
    <PreferencesProvider unchosenLang="en">
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </PreferencesProvider>,
  )

// tests/setup.ts remembers Chinese, in a browser jsdom says is English: that would count as chosen
beforeEach(() => localStorage.clear())

afterEach(() => {
  setClubFromPath('/')
  vi.restoreAllMocks()
})

describe('the landing page', () => {
  it('a visitor at the plain address can apply, or sign in to the club the root belongs to', () => {
    signedIn(null)
    setClubFromPath('/about')
    show(<LandingPage />, '/about')
    expect(screen.getByRole('heading', { level: 1, name: l.headline })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: l.signIn })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: l.apply })).toHaveAttribute('href', '/clubs/apply')
    expect(screen.getByText(l.signInOther)).toBeInTheDocument()
  })

  it('a member goes back to their club', () => {
    signedIn({ username: 'amy' })
    setClubFromPath('/about')
    show(<LandingPage />, '/about')
    expect(screen.getByRole('link', { name: l.backTo('Tamkang Bridge Club') })).toHaveAttribute('href', '/')
    expect(screen.queryByText(l.signInOther)).not.toBeInTheDocument()
  })

  it('at another club’s address it leads back there, by the name from its manifest', async () => {
    signedIn(null)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ short_name: 'NTU Bridge' }))))
    setClubFromPath('/c/ntu/about')
    show(<LandingPage />, '/about')
    expect(await screen.findByRole('link', { name: l.backTo('NTU Bridge') })).toHaveAttribute('href', '/')
    expect(fetch).toHaveBeenCalledWith('/c/ntu/manifest.webmanifest')
    vi.unstubAllGlobals()
  })

  it('says nothing about prices, users or counts', () => {
    for (const text of Object.values(l).flat()) if (typeof text === 'string') expect(text).not.toMatch(/\d{2,}|NT\$|\$|plan|price|users/i)
  })

  it('names Overtrick in every language, with the bridge terms in English (DESIGN.md §8)', () => {
    for (const t of Object.values(STRINGS)) {
      expect(t.appName).toBe('Overtrick')
      expect(t.landing.lead).toContain('Overtrick')
      expect(t.landing.analysisP).toContain('Double Dummy')
      expect(t.landing.robotsP).toContain('Precision')
      expect(t.landing.joinSteps).toHaveLength(3)
    }
  })
})

describe('home from a page anyone may read', () => {
  it('is the club’s for a member or at a club’s address, the platform’s for a visitor', () => {
    setClubFromPath('/privacy')
    expect(homePath(true)).toBe('/')
    expect(homePath(false)).toBe('/about')
    setClubFromPath('/c/ntu/privacy')
    expect(homePath(false)).toBe('/')
  })
})

describe('the header', () => {
  const clubBits = () => {
    vi.spyOn(club, 'useClub').mockReturnValue({ status: 'open', notifications: null, send: vi.fn() } as never)
  }
  const banner = () => within(screen.getByRole('banner'))

  it.each(['/about', '/privacy', '/terms', '/clubs/apply', '/share/abc'])('a visitor on %s sees the platform alone', (path) => {
    signedIn(null)
    clubBits()
    show(<AppHeader />, path)
    expect(banner().getByRole('img', { name: 'Overtrick' })).toBeInTheDocument()
    expect(banner().queryByRole('link', { name: 'Tamkang Bridge Club' })).not.toBeInTheDocument()
  })

  it('a member sees their club leading home, and the platform leading to its page', () => {
    signedIn({ id: 'amy', username: 'amy', permissions: [] })
    clubBits()
    show(<AppHeader />, '/about')
    expect(banner().getByRole('link', { name: 'Tamkang Bridge Club' })).toHaveAttribute('href', '/')
    for (const link of banner().getAllByRole('link', { name: l.link })) expect(link).toHaveAttribute('href', '/about')
  })

  it('淡江’s sign-in page is 淡江’s', () => {
    signedIn(null)
    clubBits()
    show(<AppHeader />, '/')
    expect(banner().getByRole('link', { name: 'Tamkang Bridge Club' })).toBeInTheDocument()
  })
})
