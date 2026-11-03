import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialInput } from '../../src/components/CredentialInput.tsx'
import { PasswordInput } from '../../src/components/PasswordInput.tsx'
import { LoginPage } from '../../src/pages/LoginPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Full-width typing in the sign-in fields (社長 2026-11-03, shared/halfwidth.ts) */

function Controlled({ password = false, seen }: { password?: boolean; seen: string[] }) {
  const [value, setValue] = useState('')
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    seen.push(e.target.value)
    setValue(e.target.value)
  }
  const Field = password ? PasswordInput : CredentialInput
  return <Field aria-label="欄位" value={value} onChange={onChange} />
}

const wrap = (ui: React.ReactNode) => render(<PreferencesProvider>{ui}</PreferencesProvider>)

afterEach(() => vi.unstubAllGlobals())

describe('half-width credential fields', () => {
  it('turns ＡＢＣ１２３ into ABC123 as it is typed, in a text field and a password field', async () => {
    for (const password of [false, true]) {
      const seen: string[] = []
      const { unmount } = wrap(<Controlled password={password} seen={seen} />)
      const field = screen.getByLabelText('欄位')
      await userEvent.type(field, 'ＡＢＣ１２３')
      expect(field).toHaveValue('ABC123')
      // The form's state never held a full-width character
      expect(seen.every((v) => /^[\x20-\x7E]*$/.test(v))).toBe(true)
      unmount()
    }
  })

  it('keeps the caret where it was', async () => {
    wrap(<Controlled seen={[]} />)
    const field = screen.getByLabelText<HTMLInputElement>('欄位')
    await userEvent.type(field, 'abcd')
    field.setSelectionRange(2, 2)
    await userEvent.type(field, 'Ｘ', { initialSelectionStart: 2, initialSelectionEnd: 2 })
    expect(field).toHaveValue('abXcd')
    expect(field.selectionStart).toBe(3)
  })

  it('leaves a composition alone until it ends', () => {
    const seen: string[] = []
    wrap(<Controlled seen={seen} />)
    const field = screen.getByLabelText<HTMLInputElement>('欄位')
    fireEvent.compositionStart(field)
    fireEvent.change(field, { target: { value: 'ａｂ' } })
    expect(field).toHaveValue('ａｂ')
    fireEvent.compositionEnd(field)
    expect(field).toHaveValue('ab')
    expect(seen.at(-1)).toBe('ab')
  })

  it('tells the browser the field is English-like text', () => {
    wrap(
      <>
        <CredentialInput aria-label="帳號" />
        <CredentialInput aria-label="信箱" type="email" inputMode="email" />
        <PasswordInput aria-label="密碼" />
      </>,
    )
    for (const name of ['帳號', '信箱', '密碼']) {
      const field = screen.getByLabelText(name)
      expect(field).toHaveAttribute('lang', 'en')
      expect(field).toHaveAttribute('autocapitalize', 'off')
      expect(field).toHaveAttribute('autocorrect', 'off')
      expect(field).toHaveAttribute('spellcheck', 'false')
    }
    expect(screen.getByLabelText('帳號')).toHaveAttribute('inputmode', 'text')
    expect(screen.getByLabelText('信箱')).toHaveAttribute('inputmode', 'email')
  })

  it('sends half-width sign-in details from the sign-in page', async () => {
    const sent: { path: string; body: unknown }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
        return new Response(JSON.stringify({ error: '請先登入', code: 'signInFirst', params: {} }), { status: 401 })
      }),
    )
    wrap(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    )
    await userEvent.type(screen.getByLabelText(/^帳號/), 'ａｍｙ')
    await userEvent.type(screen.getByLabelText(/^密碼/), 'ＡＢＣ１２３ｘｙｚ')
    expect(screen.getByLabelText(/^帳號/)).toHaveValue('amy')
    expect(screen.getByLabelText(/^密碼/)).toHaveValue('ABC123xyz')
    await userEvent.click(screen.getByRole('button', { name: '登入' }))
    expect(sent.find((s) => s.path === '/api/login')?.body).toMatchObject({ username: 'amy', password: 'ABC123xyz' })
  })
})
