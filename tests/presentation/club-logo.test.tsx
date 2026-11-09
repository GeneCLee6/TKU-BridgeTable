import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationLogoUrl, clubLogoUrl, LOGO_MAX_BYTES } from '../../shared/club-logo.ts'
import type { PlatformView } from '../../shared/platform.ts'
import { ClubMark } from '../../src/components/Logo.tsx'
import { encodeLogo, type EncodeCanvas } from '../../src/lib/avatarImage.ts'
import { manifestLogo } from '../../src/lib/useClubName.ts'
import { ClubApplyPage } from '../../src/pages/ClubApplyPage.tsx'
import { PlatformPage } from '../../src/pages/PlatformPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** A club's logo on the pages (AC-12.2): the header's mark, the apply form, the back office */

const wrap = (children: ReactNode) => render(<PreferencesProvider>{children}</PreferencesProvider>)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the club’s mark', () => {
  it('finds the logo among the manifest’s icons, and only the club’s own', () => {
    expect(manifestLogo([{ src: '/api/logo?club=ntu&v=3', sizes: '512x512' }])).toBe('/api/logo?club=ntu&v=3')
    expect(manifestLogo([{ src: '/icon-192.png' }, { src: '/icon-512.png' }])).toBeNull()
    expect(manifestLogo('nonsense')).toBeNull()
    expect(manifestLogo(undefined)).toBeNull()
  })

  it('shows the logo, its letter without one, and its letter when the picture does not load', () => {
    const { container, rerender } = wrap(<ClubMark name="臺大橋藝社" logo={clubLogoUrl('ntu', 5)} size={36} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('/api/logo?club=ntu&v=5')
    // Decorative: the name is written beside it
    expect(img.getAttribute('alt')).toBe('')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('臺')
    rerender(
      <PreferencesProvider>
        <ClubMark name="ntu" logo={null} />
      </PreferencesProvider>,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('N')
  })
})

describe('encodeLogo', () => {
  const encoder = (sizes: Record<string, number>, webp = true): EncodeCanvas & { asked: string[] } => {
    const asked: string[] = []
    const encode = async (type: string, quality: number) => {
      asked.push(`${type}@${quality}`)
      const written = type === 'image/webp' && !webp ? 'image/png' : type
      return new Blob([new Uint8Array(Math.round(sizes[written] ?? 1000))], { type: written })
    }
    return Object.assign(encode, { asked })
  }

  it('keeps transparency: WebP, else one PNG, and JPEG only when nothing else fits', async () => {
    expect((await encodeLogo(encoder({}), LOGO_MAX_BYTES))?.type).toBe('image/webp')
    const noWebp = encoder({ 'image/png': 5000 }, false)
    expect((await encodeLogo(noWebp, LOGO_MAX_BYTES))?.type).toBe('image/png')
    expect(noWebp.asked).toEqual(['image/webp@0.86', 'image/png@1'])
    const bigPng = encoder({ 'image/png': LOGO_MAX_BYTES * 3 }, false)
    expect((await encodeLogo(bigPng, LOGO_MAX_BYTES))?.type).toBe('image/jpeg')
    expect(bigPng.asked).toEqual(['image/webp@0.86', 'image/png@1', 'image/jpeg@0.86'])
  })
})

describe('the application’s logo', () => {
  it('is optional, and a file that is not a picture is turned down before it is read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ open: true, turnstileSiteKey: null }))))
    const { container } = wrap(<ClubApplyPage />)
    const group = await screen.findByRole('group', { name: '社團 Logo（選填）' })
    expect(within(group).getByRole('button', { name: '上傳 Logo' })).toBeInTheDocument()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), { applyAccept: false })
    expect(await screen.findByRole('alert')).toHaveTextContent('Logo 只能是正方形的 JPEG、PNG 或 WebP 圖片')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the back office', () => {
  const usage = { members: 1, admins: [], tables: 0, boards: 0, storageBytes: 0, filesBytes: 0, backupBytes: null, historyRows: null }
  const VIEW: PlatformView = {
    notices: [],
    support: [],
    clubs: [
      { id: 'tku', name: '淡江橋藝社', status: 'active', organisation: '淡江大學', contactEmail: '', usage },
      { id: 'ntu', name: '臺大橋藝社', status: 'active', organisation: '國立臺灣大學', contactEmail: '', approvedAt: 1, usage: { ...usage, logo: 77 } },
    ],
    applications: [
      {
        id: 'a2',
        clubId: 'nccu',
        name: '政大橋藝社',
        organisation: '國立政治大學',
        contactEmail: 'b@example.org',
        reason: '想要開社團牌桌',
        username: 'nccuhead',
        createdAt: 1,
        status: 'pending',
        logo: true,
      },
    ],
    totals: { members: 2, filesBytes: 0, backupBytes: 0, historyRows: 0, storageBytes: 0 },
  }

  it('shows each club’s logo and the logo an application came with', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(VIEW))))
    wrap(<PlatformPage />)
    const clubs = await screen.findByRole('table', { name: '社團' })
    const logos = [...clubs.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(logos).toEqual([clubLogoUrl('ntu', 77)])
    expect(screen.getByRole('img', { name: '政大橋藝社 的 Logo' })).toHaveAttribute('src', applicationLogoUrl('a2'))
  })
})
