import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TKU_CARD_API } from '../../shared/protocol.ts'
import { deriveCard } from '../../shared/robot/system/card.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { setClubFromPath } from '../../src/lib/club.ts'
import { SystemCardDialog, SystemCardView } from '../../src/components/SystemCardView.tsx'
import { SeatPlate, type SeatAction } from '../../src/components/SeatPlate.tsx'
import { SystemCardPage } from '../../src/pages/SystemCardPage.tsx'
import { STRINGS } from '../../src/strings.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

vi.mock('../../src/state/AuthContext.tsx', async (original) => ({
  ...(await original<typeof import('../../src/state/AuthContext.tsx')>()),
  useAuth: () => ({ user: { permissions: [] } }),
}))

const t = STRINGS.zh
const s = t.systemCard

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

describe('system card', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    fetchSpy.mockReset()
    // The server: the club's card, as worker/system-card.ts sends it
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(deriveCard(TKU))))
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    setClubFromPath('/')
  })

  it('shows the club’s card from the rules: 1NT 15–17, its own conventions and article links', async () => {
    wrap(<SystemCardView system="tku" />)
    expect(await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('15–17 大牌點')
    expect(text).toContain('一高弱二')
    expect(text).toContain('RKCB 1430')
    expect(text).toContain(s.sources.tku)
    expect(screen.getAllByRole('link', { name: '雷本索特約' })[0].getAttribute('href')).toContain('lebensohl')
  })

  it('shows the 2/1 card: its own conventions, no handbook', async () => {
    wrap(<SystemCardView system="gib" />)
    expect(await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('RKCB 0314')
    expect(text).toContain('Jacoby 2NT')
    expect(text).not.toContain('一高弱二')
    expect(text).toContain(s.sources.gib)
    expect(screen.queryByText(s.articles)).toBeNull()
  })

  it('shows the SAYC card: plain Blackwood and no handbook', async () => {
    wrap(<SystemCardView system="sayc" />)
    expect(await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).toContain('黑木問 A')
    expect(text).not.toContain('RKCB')
    expect(text).not.toContain('一高弱二')
    expect(text).toContain(s.sources.sayc)
    expect(screen.queryByText(s.articles)).toBeNull()
  })

  it('has every section, leads and signals included', async () => {
    wrap(<SystemCardView system="gib" />)
    await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })
    for (const name of Object.values(s.sections)) expect(screen.getAllByText(name).length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain(s.signals.attitudeLike)
  })

  it('the 2/1 card asks the server nothing', async () => {
    wrap(<SystemCardView system="gib" />)
    await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the club’s card comes from the server, asking only for the card', async () => {
    wrap(<SystemCardView system="tku" />)
    await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe(TKU_CARD_API)
    expect(fetchSpy.mock.calls[0][1].body).toBeUndefined()
  })

  it('says so when the server refuses the club’s card', async () => {
    fetchSpy.mockImplementation(async () => new Response('{"code":"noSuchApi"}', { status: 404 }))
    wrap(<SystemCardView system="tku" />)
    expect(await screen.findByText(s.unavailable)).toBeTruthy()
    expect(document.body.textContent).not.toContain('RKCB 1430')
  })

  it('the dialog takes the system alone, closes with Esc and from its button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    wrap(<SystemCardDialog system="gib" onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: s.cardOf('2/1') })
    await within(dialog).findByText(s.sections.leads, {}, { timeout: 10_000 })
    // In a new tab: leaving the page would leave the table (CLAUDE.md)
    const page = within(dialog).getByRole('link', { name: s.openPage })
    expect(page.getAttribute('target')).toBe('_blank')
    expect(page.getAttribute('href')).toContain('/system-card/gib')
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await user.click(within(dialog).getByRole('button', { name: t.close }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('the page switches between the two cards, and defaults to the one the member can seat', async () => {
    const user = userEvent.setup()
    wrap(
      <MemoryRouter initialEntries={['/system-card']}>
        <Routes>
          <Route path="/system-card" element={<SystemCardPage />} />
          <Route path="/system-card/:system" element={<SystemCardPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })
    expect(document.body.textContent).toContain('RKCB 0314')
    expect(screen.getByRole('link', { name: '2/1' }).getAttribute('aria-current')).toBe('page')
    await user.click(screen.getByRole('link', { name: t.robotSystems.tku }))
    await waitFor(() => expect(document.body.textContent).toContain('RKCB 1430'))
  })

  it('in another club the page has only the 2/1 card, even at the club card’s address', async () => {
    setClubFromPath('/c/ntu/system-card/tku')
    wrap(
      <MemoryRouter initialEntries={['/system-card/tku']}>
        <Routes>
          <Route path="/system-card/:system" element={<SystemCardPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await screen.findByText(s.sections.leads, {}, { timeout: 10_000 })
    expect(document.body.textContent).toContain('RKCB 0314')
    expect(screen.queryByRole('link', { name: t.robotSystems.tku })).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a robot’s seat menu offers its card; the host’s other actions stay', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const actions: SeatAction[] = [{ label: s.open(t.robotSystems.gib), onSelect: open }]
    const robot = { id: 'robot:gib:N', username: 'TKB', robot: true, robotKind: 'gib', online: true } as never
    wrap(<SeatPlate seat="N" occupant={robot} vulnerable={false} turn={false} isMe={false} actions={actions} />)
    await user.click(screen.getByRole('button', { expanded: false }))
    await user.click(screen.getByRole('menuitem', { name: s.open('2/1') }))
    expect(open).toHaveBeenCalled()
  })
})
