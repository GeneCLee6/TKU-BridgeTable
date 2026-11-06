import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChallengeBanner } from '../../src/components/ChallengeBanner.tsx'
import { formatDateTime, formatTime } from '../../src/lib/format.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const DEADLINE = Date.UTC(2026, 9, 27, 8)

const show = (seq: number, played: number) =>
  render(
    <PreferencesProvider>
      <ChallengeBanner challenge={{ id: 'c1', seq, boards: 8, played, deadline: DEADLINE }} />
    </PreferencesProvider>,
  )

describe('ChallengeBanner (e7-t15)', () => {
  it('says which board of the challenge this is, and until when', () => {
    show(3, 2)
    expect(screen.getByText('挑戰 · 第 3／8 副')).toBeInTheDocument()
    expect(screen.getByText(/^截止 /).textContent).toBe(`截止 ${formatDateTime(DEADLINE, 'zh')}`)
  })

  it('before the first deal names the board to come', () => {
    show(0, 0)
    expect(screen.getByText('挑戰 · 第 1／8 副')).toBeInTheDocument()
  })
})

describe('ChallengeBanner at a partnership’s table (e7-t28)', () => {
  it('says the table waits while the partner is not seated', () => {
    render(
      <PreferencesProvider>
        <ChallengeBanner challenge={{ id: 'c1', seq: 2, boards: 8, played: 1, deadline: DEADLINE, partnerAway: true }} />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('搭檔不在桌上，等他入座再繼續')
  })

  it('says until when a partner who dropped offline keeps their seat (社長 2026-11-02)', () => {
    const until = DEADLINE - 3600_000
    render(
      <PreferencesProvider>
        <ChallengeBanner challenge={{ id: 'c1', seq: 2, boards: 8, played: 1, deadline: DEADLINE, partnerOfflineUntil: until }} />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(`搭檔斷線了：${formatTime(until, 'zh')} 前沒回來，這一副就先擱著`)
  })

  it('says the board is set aside once that partner was away too long', () => {
    render(
      <PreferencesProvider>
        <ChallengeBanner
          challenge={{ id: 'c1', seq: 2, boards: 8, played: 1, deadline: DEADLINE, partnerAway: true, partnerDropped: true }}
        />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/^搭檔斷線太久，這一副先擱著/)
  })
})
