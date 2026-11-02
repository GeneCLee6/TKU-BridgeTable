import { useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import type { TwoFactorSetup } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { PasswordInput } from './PasswordInput.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Input, Muted } from './ui.tsx'

/**
 * "My account"'s 兩步驟登入 (e11-t31): set up with an authenticator app (its `otpauth://` link on
 * the phone, or the key typed in), confirm with the first code, keep the recovery codes shown once;
 * then new recovery codes or turning it off, each with the password and a code. Shown only when the
 * server sends `Me.twoFactor`, that is to admins and to anyone who has it on
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Status = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`

const Secret = styled.code`
  display: block;
  padding: ${({ theme }) => theme.space(2)} ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.text};
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  letter-spacing: 0.08em;
  overflow-wrap: anywhere;
  user-select: all;
`

const Codes = styled.ol`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: ${({ theme }) => theme.space(2)};
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  list-style: none;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.text};
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  user-select: all;
`

const AppLink = styled.a`
  color: ${({ theme }) => theme.colors.primary};
  font-weight: 600;
`

export function TwoFactorCard() {
  const { t, lang, message } = usePreferences()
  const s = t.twoFactor
  const toast = useToast()
  const { user, refresh } = useAuth()
  const id = useId()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null)
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const state = user?.twoFactor
  if (!state) return null

  const run = async (act: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try {
      await act()
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }
  const done = async (text?: string) => {
    setPassword('')
    setCode('')
    if (text) toast.success(text)
    await refresh()
  }

  const start = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      setSetup(await api.twoFactor.setup(password))
      setPassword('')
    })
  }
  const enable = (event: FormEvent) => {
    event.preventDefault()
    void run(async () => {
      const answer = await api.twoFactor.enable(code)
      setSetup(null)
      setRecovery(answer.recoveryCodes)
      await done(s.enabled)
    })
  }
  const confirmed = () => {
    if (password && code) return true
    setError(s.fillFirst)
    return false
  }
  const renew = () => {
    if (!confirmed() || !window.confirm(s.renewConfirm)) return
    void run(async () => {
      setRecovery((await api.twoFactor.renew(password, code)).recoveryCodes)
      await done()
    })
  }
  const disable = () => {
    if (!confirmed() || !window.confirm(s.disableConfirm)) return
    void run(async () => {
      await api.twoFactor.disable(password, code, lang)
      await done(s.disabled)
    })
  }

  const header = (
    <CardHeader>
      <CardTitle>{s.title}</CardTitle>
    </CardHeader>
  )
  const passwordField = (
    <Field>
      <FieldLabel htmlFor={`${id}-password`}>{s.password}</FieldLabel>
      <PasswordInput
        id={`${id}-password`}
        value={password}
        autoComplete="current-password"
        onChange={(ev) => setPassword(ev.target.value)}
        required
      />
    </Field>
  )
  const codeField = (label: string) => (
    <Field>
      <FieldLabel htmlFor={`${id}-code`}>{label}</FieldLabel>
      <Input
        id={`${id}-code`}
        value={code}
        inputMode={state.enabled ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={20}
        onChange={(ev) => setCode(ev.target.value)}
        required
      />
    </Field>
  )

  // The recovery codes, right after they were made: shown this once
  if (recovery) {
    return (
      <Card aria-label={s.title}>
        {header}
        <Stack>
          <Status role="status">{s.recoveryTitle}</Status>
          <Muted>{s.recoveryIntro}</Muted>
          <Codes aria-label={s.recoveryTitle}>
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </Codes>
        </Stack>
        <CardFooter>
          <Button type="button" $variant="primary" onClick={() => setRecovery(null)}>
            {s.recoverySaved}
          </Button>
        </CardFooter>
      </Card>
    )
  }

  if (setup) {
    return (
      <Card as="form" onSubmit={enable} aria-label={s.title}>
        {header}
        <Stack>
          <Muted>{s.step1}</Muted>
          <AppLink href={setup.uri}>{s.openApp}</AppLink>
          <div>
            <FieldLabel as="span">{s.secret}</FieldLabel>
            <Secret>{setup.secret.replace(/(.{4})(?=.)/g, '$1 ')}</Secret>
          </div>
          <Muted>{s.step2}</Muted>
          {error && <ErrorText role="alert">{error}</ErrorText>}
          {codeField(s.code)}
        </Stack>
        <CardFooter>
          <Button type="submit" $variant="primary" $busy={busy}>
            {s.enable}
          </Button>
          <Button type="button" disabled={busy} onClick={() => setSetup(null)}>
            {t.cancel}
          </Button>
        </CardFooter>
      </Card>
    )
  }

  if (!state.enabled) {
    return (
      <Card as="form" onSubmit={start} aria-label={s.title}>
        {header}
        <Stack>
          <Muted>{s.intro}</Muted>
          <Status role="status">{s.off}</Status>
          {error && <ErrorText role="alert">{error}</ErrorText>}
          {passwordField}
        </Stack>
        <CardFooter>
          <Button type="submit" $variant="primary" $busy={busy}>
            {s.start}
          </Button>
        </CardFooter>
      </Card>
    )
  }

  return (
    <Card as="form" onSubmit={(ev: FormEvent) => ev.preventDefault()} aria-label={s.title}>
      {header}
      <Stack>
        <Muted>{s.intro}</Muted>
        <Status role="status">{s.on(state.recoveryLeft)}</Status>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        {passwordField}
        {codeField(s.codeOrRecovery)}
      </Stack>
      <CardFooter>
        <Button type="button" disabled={busy} onClick={renew}>
          {s.renew}
        </Button>
        <Button type="button" $variant="danger" disabled={busy} onClick={disable}>
          {s.disable}
        </Button>
      </CardFooter>
    </Card>
  )
}
