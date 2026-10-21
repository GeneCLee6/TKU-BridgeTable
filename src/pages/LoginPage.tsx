import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { LIMITS } from '../../shared/protocol.ts'
import { LogoMark } from '../components/Logo.tsx'
import { Button, Card, ErrorText, Muted } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { strings } from '../strings.ts'

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

export function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const registering = mode === 'register'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (registering) await register(username, password, inviteCode)
      else await login(username, password)
    } catch (e) {
      setError(e instanceof Error ? e.message : strings.genericError)
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
            {strings.appNameEn} · {strings.appNameZh}
          </h1>
          <Muted>{strings.loginIntro}</Muted>
        </Brand>
        <Form onSubmit={submit} aria-label={registering ? strings.register : strings.login}>
          <Field>
            {strings.username}
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={LIMITS.usernameMin}
              maxLength={LIMITS.usernameMax}
            />
            {registering && <small>{strings.usernameHint(LIMITS.usernameMin, LIMITS.usernameMax)}</small>}
          </Field>
          <Field>
            {strings.password}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={registering ? 'new-password' : 'current-password'}
              required
              minLength={registering ? LIMITS.passwordMin : undefined}
            />
            {registering && <small>{strings.passwordHint(LIMITS.passwordMin)}</small>}
          </Field>
          {registering && (
            <Field>
              {strings.inviteCode}
              <input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} autoComplete="off" />
              <small>{strings.inviteHint}</small>
            </Field>
          )}
          {error && <ErrorText role="alert">{error}</ErrorText>}
          <Button type="submit" $variant="primary" disabled={busy}>
            {registering ? strings.register : strings.login}
          </Button>
        </Form>
        <Switch>
          {registering ? strings.haveAccount : strings.noAccount}{' '}
          <Button
            type="button"
            $variant="ghost"
            $small
            onClick={() => {
              setMode(registering ? 'login' : 'register')
              setError('')
            }}
          >
            {registering ? strings.login : strings.register}
          </Button>
        </Switch>
      </Panel>
    </Wrap>
  )
}
