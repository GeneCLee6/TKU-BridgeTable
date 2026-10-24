import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ChallengeBanner } from '../../src/components/ChallengeBanner.tsx'
import { formatDateTime } from '../../src/lib/format.ts'
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
