import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROBOT_SPEED, ROBOT_PACE, ROBOT_SPEEDS, slowestSpeed } from '../../shared/protocol.ts'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { PACES, paceOf } from '../../src/lib/motion.ts'
import { AccountPage } from '../../src/pages/AccountPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

afterEach(() => vi.unstubAllGlobals())

describe('the robot speeds (出牌速度)', () => {
  it('let each card land before a robot plays the next, and show a finished trick a moment', () => {
    for (const speed of ROBOT_SPEEDS) {
      const robot = ROBOT_PACE[speed]
      const pace = PACES[speed]
      expect(pace.glideMs).toBeLessThan(robot.card)
      // The trick's last card has landed and is seen whole for at least half a second before the lead takes it
      expect(robot.afterTrick - pace.glideMs).toBeGreaterThanOrEqual(500)
      expect(pace.landsAfterS * 1000).toBeLessThan(pace.glideMs)
    }
    // Each speed is slower than the one before
    for (let i = 1; i < ROBOT_SPEEDS.length; i++)
      expect(ROBOT_PACE[ROBOT_SPEEDS[i]].card).toBeGreaterThan(ROBOT_PACE[ROBOT_SPEEDS[i - 1]].card)
    expect(paceOf(undefined)).toBe(PACES[DEFAULT_ROBOT_SPEED])
  })

  it('go at the slowest of the people seated', () => {
    expect(slowestSpeed([])).toBe(DEFAULT_ROBOT_SPEED)
    expect(slowestSpeed(['veryFast', 'fast'])).toBe('fast')
    expect(slowestSpeed(['slower', 'veryFast', 'fast'])).toBe('slower')
  })
})

describe('my account: the robot speed', () => {
  it('shows the saved speed and saves a new one on the server', async () => {
    let me: Record<string, unknown> = { id: 'amy', username: 'amy', admin: false, permissions: [], robotSpeed: 'veryFast' }
    const posts: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/account/preferences' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          posts.push(body)
          me = { ...me, ...body }
        }
        return new Response(JSON.stringify({ user: me }), { status: 200 })
      }),
    )
    render(
      <PreferencesProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter>
              <AccountPage />
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </PreferencesProvider>,
    )
    const speeds = await screen.findByRole('group', { name: '機器人出牌速度' })
    expect(speeds).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '極快' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: '較慢' }))
    expect(posts).toEqual([{ robotSpeed: 'slower' }])
    expect(await screen.findByRole('radio', { name: '較慢' })).toBeChecked()
  })
})
