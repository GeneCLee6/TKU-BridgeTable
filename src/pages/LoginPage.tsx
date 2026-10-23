import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { LIMITS } from '../../shared/protocol.ts'
import { LogoMark } from '../components/Logo.tsx'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { Button, Card, ErrorText, Muted } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { api, ApiError } from '../lib/api.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'

const Wrap = styled.main`
  display: grid;
  place-items: center;
  min-height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});
  padding: 24px 16px;
`

const Panel = styled(Card)`
  width: min(100%, 380px);
  display: grid;
  gap: 16px;
`

const Brand = styled.div`
  display: grid;
  justify-items: center;
  gap: 4px;
  color: ${({ theme }) => theme.colors.primary};
  text-align: center;

  & > h1 { margin: 0; font-size: 22px; color: ${({ theme }) => theme.colors.primaryStrong}; }
`

const Form = styled.form`
  display: grid;
  gap: 12px;
`

const Field = styled.label`
  display: grid;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;

  & > input {
    min-height: 42px;
    padding: 0 12px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.bg};
    font-size: 16px;
    font-weight: 400;
  }
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 400;
  }
`

const Switch = styled.p`
  margin: 0;
  text-align: center;
  font-size: 14px;
`

const Done = styled.p`
  margin: 0;
  padding: 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  line-height: 1.6;
`

const Footnote = styled(Muted)`
  margin: 0;
  text-align: center;
  font-size: 13px;
`

type Mode = 'login' | 'register' | 'reset'

/**
 * Sign in, register and 忘記密碼. Registering sends an application that an admin approves on the
 * admin page (only the club's first account signs in at once); the account then works on both
 * TKU BridgeTable and TKU BridgeBook.
 */
export function LoginPage() {
  const t = useT()
  const { message } = usePreferences()
  const { login, register } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  const registering = mode === 'register'
  const resetting = mode === 'reset'
  const title = registering ? t.register : resetting ? t.resetTitle : t.login

  const switchTo = (next: Mode) => {
    setMode(next)
    setError('')
    setDone('')
    setPassword('')
    setRepeat('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (resetting && password !== repeat) {
      setError(t.passwordMismatch)
      return
    }
    setBusy(true)
    try {
      if (registering) {
        const result = await register(username, password, inviteCode, note)
        if ('pending' in result) setDone(t.applicationSent(result.username))
      } else if (resetting) {
        await api.resetPassword(username, inviteCode, password)
        switchTo('login')
        setDone(t.resetDone)
      } else await login(username, password)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Wrap>
      <Panel>
        <Brand>
          <LogoMark size={56} />
          <h1>
            {t.appNameEn} · {t.appNameZh}
          </h1>
          <Muted>{resetting ? t.resetIntro : t.loginIntro}</Muted>
        </Brand>
        {done && registering ? (
          <>
            <Done role="status">{done}</Done>
            <Button type="button" $variant="primary" onClick={() => switchTo('login')}>
              {t.backToLogin}
            </Button>
          </>
        ) : (
          <Form onSubmit={submit} aria-label={title}>
            {done && <Done role="status">{done}</Done>}
            <Field>
              {t.username}
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                minLength={LIMITS.usernameMin}
                maxLength={LIMITS.usernameMax}
              />
              {registering && <small>{t.usernameHint(LIMITS.usernameMin, LIMITS.usernameMax)}</small>}
            </Field>
            <Field>
              {resetting ? t.newPassword : t.password}
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'login' ? undefined : LIMITS.passwordMin}
              />
              {mode !== 'login' && <small>{t.passwordHint(LIMITS.passwordMin)}</small>}
            </Field>
            {resetting && (
              <Field>
                {t.confirmPassword}
                <PasswordInput
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </Field>
            )}
            {mode !== 'login' && (
              <Field>
                {t.inviteCode}
                <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />
                <small>{t.inviteHint}</small>
              </Field>
            )}
            {registering && (
              <Field>
                {t.applicationNote}
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={LIMITS.applicationNoteMax}
                  autoComplete="off"
                />
                <small>{t.applicationNoteHint}</small>
              </Field>
            )}
            {error && <ErrorText role="alert">{error}</ErrorText>}
            <Button type="submit" $variant="primary" disabled={busy}>
              {title}
            </Button>
            {mode === 'login' && (
              <Button type="button" $variant="ghost" $small onClick={() => switchTo('reset')}>
                {t.forgotPassword}
              </Button>
            )}
          </Form>
        )}
        <Switch>
          {resetting ? (
            <Button type="button" $variant="ghost" $small onClick={() => switchTo('login')}>
              {t.backToLogin}
            </Button>
          ) : (
            <>
              {registering ? t.haveAccount : t.noAccount}{' '}
              <Button type="button" $variant="ghost" $small onClick={() => switchTo(registering ? 'login' : 'register')}>
                {registering ? t.login : t.register}
              </Button>
            </>
          )}
        </Switch>
        <Footnote>{t.sharedAccountHint}</Footnote>
      </Panel>
    </Wrap>
  )
}
