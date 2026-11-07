import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PRODUCT_FEATURES, type ProductMetricsView } from '../../shared/protocol.ts'
import { ProductMetrics } from '../../src/components/ProductMetrics.tsx'
import { STRINGS } from '../../src/strings.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const mocks = vi.hoisted(() => ({ productMetrics: vi.fn(), setProductMetrics: vi.fn(), success: vi.fn() }))

vi.mock('../../src/lib/api.ts', async (actual) => ({
  ...(await actual<typeof import('../../src/lib/api.ts')>()),
  api: { admin: { productMetrics: mocks.productMetrics, setProductMetrics: mocks.setProductMetrics } },
}))
vi.mock('../../src/components/Toast.tsx', () => ({ useToast: () => ({ success: mocks.success, error: vi.fn() }) }))

const t = STRINGS.zh.productMetrics

const EMPTY: ProductMetricsView = {
  enabled: true,
  minCount: 5,
  since: null,
  days: [{ day: '2026-11-07', active: null }],
  weeks: [{ week: '2026-11-02', active: null, tables: null, boards: null, boardsPerTable: null }],
  boardsPerTable: null,
  retention: { weeks: [], rows: [] },
  features: PRODUCT_FEATURES.map((key) => ({ key, count: null })),
}

const FULL: ProductMetricsView = {
  ...EMPTY,
  since: '2026-10-01',
  days: [
    { day: '2026-11-06', active: 8 },
    { day: '2026-11-07', active: null },
  ],
  weeks: [{ week: '2026-11-02', active: 12, tables: 6, boards: 30, boardsPerTable: 5 }],
  boardsPerTable: 5,
  retention: {
    weeks: ['2026-10-26'],
    rows: [
      { cohort: null, size: 20, cells: [{ week: '2026-10-26', active: 15 }] },
      { cohort: '2026-10-26', size: null, cells: [{ week: '2026-10-26', active: null }] },
    ],
  },
  features: [{ key: 'puzzleSolved', count: 9 }, { key: 'boardImport', count: null }],
}

const show = (ui: ReactNode) =>
  render(
    <PreferencesProvider>
      {ui}
    </PreferencesProvider>,
  )

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ProductMetrics', () => {
  it('says plainly when there is too little to show', async () => {
    mocks.productMetrics.mockResolvedValue(EMPTY)
    show(<ProductMetrics />)
    expect(await screen.findByText(t.empty(5))).toBeInTheDocument()
    expect(screen.queryByText(t.dauTitle)).not.toBeInTheDocument()
  })

  it('shows the numbers, and what the server hid as hidden', async () => {
    mocks.productMetrics.mockResolvedValue(FULL)
    show(<ProductMetrics />)
    expect(await screen.findByText(t.dauTitle)).toBeInTheDocument()
    expect(screen.getByText(t.since('2026-10-01'))).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('–')).toBeInTheDocument()
    expect(screen.getByText(t.boardsValue(5))).toBeInTheDocument()
    expect(screen.getByText(t.features.puzzleSolved).nextSibling).toHaveTextContent('9')
    expect(screen.getByText(t.features.boardImport).nextSibling).toHaveTextContent(t.hidden(5))
  })

  it('says the switch is for both sites, and saves it', async () => {
    mocks.productMetrics.mockResolvedValue(EMPTY)
    mocks.setProductMetrics.mockResolvedValue({ ...EMPTY, enabled: false })
    show(<ProductMetrics />)
    const box = await screen.findByRole('checkbox', { name: t.switchLabel })
    expect(t.switchLabel).toContain('淡江橋館')
    await userEvent.click(box)
    expect(mocks.setProductMetrics).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.getByText(t.off)).toBeInTheDocument())
  })

  it('has the switch’s warning in every language', () => {
    for (const lang of Object.values(STRINGS)) expect(lang.productMetrics.switchLabel).toMatch(/淡江橋館|淡江桥馆|BridgeHall/)
  })
})
