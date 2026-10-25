import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ClaimPicker } from '../../src/components/TablePanels.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

function setup() {
  const onClaim = vi.fn()
  const onCancel = vi.fn()
  render(
    <PreferencesProvider>
      <ClaimPicker remaining={4} onClaim={onClaim} onCancel={onCancel} />
    </PreferencesProvider>,
  )
  return { onClaim, onCancel }
}

describe('the claim picker', () => {
  it('only chooses a number on click; 確定 sends it', async () => {
    const { onClaim } = setup()
    const confirm = screen.getByRole('button', { name: '確定' })
    expect(confirm).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: '3 墩' }))
    expect(onClaim).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '3 墩' })).toHaveAttribute('aria-pressed', 'true')
    // Choosing another number moves the choice
    await userEvent.click(screen.getByRole('button', { name: '2 墩' }))
    expect(screen.getByRole('button', { name: '3 墩' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('攤牌：再拿 2 墩')).toBeInTheDocument()
    await userEvent.click(confirm)
    expect(onClaim).toHaveBeenCalledExactlyOnceWith(2)
  })

  it('confirms with Enter and cancels with Escape', async () => {
    const { onClaim, onCancel } = setup()
    await userEvent.keyboard('{Enter}')
    expect(onClaim).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '4 墩' }))
    await userEvent.keyboard('{Enter}')
    expect(onClaim).toHaveBeenCalledExactlyOnceWith(4)
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('cancels with 取消 without claiming', async () => {
    const { onClaim, onCancel } = setup()
    await userEvent.click(screen.getByRole('button', { name: '1 墩' }))
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onClaim).not.toHaveBeenCalled()
  })
})
