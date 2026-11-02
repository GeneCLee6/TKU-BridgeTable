import { useEffect, useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { LIMITS } from '../../shared/protocol.ts'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { Button, Card, ErrorText, Field, FieldError, FieldHint, FieldLabel, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The pages the email links open (e1-t29, e1-t30), signed in or not: `/email/verify#<token>`
 * confirms an address, `/email/reset#<token>` sets a new password. The secret rides in the
 * fragment, which browsers never send to a server, and is taken off the address bar at once. A
 * button does the work, not opening the page, so a mail scanner that follows links uses nothing up
 */

const Panel = styled(Card)`
  width: min(100%, 420px);
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
  border-top: 3px solid ${({ theme }) => theme.colors.accent};
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Done = styled.p`
  margin: 0;
  padding: 10px 12px;
  border-left: 4px solid ${({ theme }) => theme.colors.success};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.successSoft};
  color: ${({ theme }) => theme.colors.text};
  line-height: 1.6;
  overflow-wrap: anywhere;
`

/** The token from the address's fragment, read once and then taken off the address bar */
function useLinkToken(): string {
  const [token] = useState(() => window.location.hash.slice(1))
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [])
  return token
}

export function EmailLinkPage({ kind }: { kind: 'verify' | 'reset' }) {
  const { t, message } = usePreferences()
  const e = t.email
  const { user, refresh } = useAuth()
  const token = useLinkToken()
  const id = useId()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  const verifying = kind === 'verify'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setMismatch(false)
    if (!verifying && password !== repeat) {
      setMismatch(true)
      return
    }
    setBusy(true)
    try {
      if (verifying) {
        const { username, address } = await api.verifyEmail(token)
        setDone(e.verifiedDone(username, address))
      } else {
        const { username } = await api.resetPasswordByEmail(token, password)
        setDone(e.passwordDone(username))
      }
      // A signed-in member sees the new address, or is signed out by the new password
      if (user) await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  const title = verifying ? e.verifyTitle : e.newPasswordTitle
  return (
    <PageMain>
      <PageTitle>{title}</PageTitle>
      <Panel>
        {done ? (
          <Done role="status">{done}</Done>
        ) : !token ? (
          <ErrorText role="alert">{e.linkMissing}</ErrorText>
        ) : (
          <Form onSubmit={submit} aria-label={title}>
            <Muted>{verifying ? e.verifyIntro : e.newPasswordIntro}</Muted>
            {error && <ErrorText role="alert">{error}</ErrorText>}
            {!verifying && (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-password`}>{t.newPassword}</FieldLabel>
                  <PasswordInput
                    id={`${id}-password`}
                    aria-describedby={`${id}-password-hint`}
                    value={password}
                    onChange={(ev) => setPassword(ev.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={LIMITS.passwordMin}
                  />
                  <FieldHint id={`${id}-password-hint`}>{t.passwordHint(LIMITS.passwordMin)}</FieldHint>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-repeat`}>{t.confirmPassword}</FieldLabel>
                  <PasswordInput
                    id={`${id}-repeat`}
                    aria-invalid={mismatch || undefined}
                    aria-describedby={mismatch ? `${id}-repeat-error` : undefined}
                    value={repeat}
                    onChange={(ev) => setRepeat(ev.target.value)}
                    autoComplete="new-password"
                    required
                  />
                  {mismatch && (
                    <FieldError id={`${id}-repeat-error`} role="alert">
                      {t.passwordMismatch}
                    </FieldError>
                  )}
                </Field>
              </>
            )}
            <Button type="submit" $variant="primary" $size="lg" $busy={busy}>
              {verifying ? e.verifyButton : e.newPasswordTitle}
            </Button>
          </Form>
        )}
        <a href="/">{e.toSite}</a>
      </Panel>
    </PageMain>
  )
}
