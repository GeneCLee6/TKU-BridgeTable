import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordInput } from '../../src/components/PasswordInput.tsx'
import { ToastProvider, useToast, type ToastApi } from '../../src/components/Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, Field, FieldError, FieldLabel, Input } from '../../src/components/ui.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

/** Renders a ToastProvider and hands back its functions */
function toasts() {
  const held: { api?: ToastApi } = {}
  function Grab() {
    const api = useToast()
    useEffect(() => {
      held.api = api
    })
    return null
  }
  wrap(
    <ToastProvider>
      <Grab />
    </ToastProvider>,
  )
  return held.api!
}

afterEach(() => vi.useRealTimers())

describe('Toast', () => {
  it('announces success and info as status, errors as alert', () => {
    const toast = toasts()
    act(() => {
      toast.success('已儲存')
      toast.info('已複製連結')
      toast.error('連線中斷')
    })
    const statuses = screen.getAllByRole('status')
    expect(statuses.map((s) => s.textContent)).toEqual(['已儲存', '已複製連結'])
    expect(screen.getByRole('alert')).toHaveTextContent('連線中斷')
  })

  it('closes success after four seconds but keeps errors until closed', async () => {
    vi.useFakeTimers()
    const toast = toasts()
    act(() => {
      toast.success('已儲存')
      toast.error('儲存失敗')
    })
    act(() => vi.advanceTimersByTime(4100))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('儲存失敗')
    vi.useRealTimers()
    await userEvent.click(screen.getByRole('button', { name: '關閉' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps at most three, the newest last', () => {
    const toast = toasts()
    act(() => {
      for (const n of [1, 2, 3, 4]) toast.info(`第 ${n} 則`)
    })
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['第 2 則', '第 3 則', '第 4 則'])
  })
})

describe('Button', () => {
  it('keeps the old props working and blocks a second press while busy', async () => {
    const onClick = vi.fn()
    wrap(
      <>
        <Button $small $variant="danger" onClick={onClick}>
          刪除
        </Button>
        <Button $variant="primary" $size="lg" $busy onClick={onClick}>
          儲存中…
        </Button>
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: '刪除' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: '儲存中…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(busy)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('Form parts', () => {
  it('ties a field error to its input', () => {
    wrap(
      <Card>
        <CardHeader>
          <CardTitle>人數上限</CardTitle>
        </CardHeader>
        <Field>
          <FieldLabel htmlFor="limit">上限</FieldLabel>
          <Input id="limit" aria-invalid aria-describedby="limit-error" />
          <FieldError id="limit-error">請輸入 1–500</FieldError>
        </Field>
        <CardFooter>
          <Button $variant="primary">儲存</Button>
        </CardFooter>
      </Card>,
    )
    expect(screen.getByLabelText('上限')).toHaveAccessibleDescription('請輸入 1–500')
    expect(screen.getByRole('heading', { name: '人數上限' })).toBeInTheDocument()
  })

  it('makes the password field a plain native password input', () => {
    wrap(<PasswordInput aria-label="密碼" />)
    const field = screen.getByLabelText('密碼')
    expect(field.tagName).toBe('INPUT')
    expect(field).toHaveAttribute('type', 'password')
    expect(getComputedStyle(field).letterSpacing).not.toMatch(/[1-9]/)
  })
})
