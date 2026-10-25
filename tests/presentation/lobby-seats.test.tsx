import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TableSummary } from '../../shared/protocol.ts'
import { TableTile } from '../../src/pages/LobbyPage.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** The lobby's seat cells: a robot as TKB and a system tag, a member as avatar and name, the full name in `title` */

const LONG = 'Christopher Wellington-Smythe'

const TABLE: TableSummary = {
  id: 't1',
  number: 4,
  hostName: 'Eve',
  settings: { visibility: 'public', allowKibitz: true, boardMinutes: 0 },
  welcome: true,
  seats: {
    N: { id: 'chris', username: LONG, online: true },
    E: { id: 'robot:gib:E', username: 'TKB', robot: true, robotKind: 'gib', online: true },
    S: null,
    W: { id: 'robot:tku:W', username: 'TKB', robot: true, robotKind: 'tku', online: true, substituteFor: 'Dan' },
  },
  spectators: 0,
  boardsPlayed: 0,
  boardNo: null,
}

function renderTile(onSit = vi.fn()) {
  render(
    <PreferencesProvider>
      <TableTile table={TABLE} onSit={onSit} onWatch={() => {}} />
    </PreferencesProvider>,
  )
  return onSit
}

describe('lobby seat cells', () => {
  it('shows a robot as TKB with a short system tag, its full name in the title', () => {
    renderTile()
    const east = screen.getByRole('button', { name: 'E TKB（2/1）' })
    expect(east).toHaveAttribute('title', 'TKB（2/1）')
    expect(east).toHaveTextContent(/^ETKB2\/1$/)
    const west = screen.getByRole('button', { name: 'W TKB（淡江制度） · 代打 Dan' })
    expect(within(west).getByText('淡江')).toBeInTheDocument()
    expect(west).not.toHaveTextContent('淡江制度')
  })

  it('shows a member with their avatar and their whole name in the title', () => {
    renderTile()
    const north = screen.getByRole('button', { name: `N ${LONG}` })
    expect(north).toHaveAttribute('title', LONG)
    expect(north.querySelector('[data-avatar]')).not.toBeNull()
    expect(north).toBeDisabled()
  })

  it('lets a member sit in an empty seat', async () => {
    const onSit = renderTile()
    await userEvent.click(screen.getByRole('button', { name: '坐下 S' }))
    expect(onSit).toHaveBeenCalledWith('S')
  })
})
