import { useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { PasswordInput } from './PasswordInput.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Input, Muted } from './ui.tsx'

/**
 * "My account"'s email (e1-t29): the verified address, one waiting for its link, binding or
 * changing it (a link goes to it) and removing it, each with the password. Shown only when the
 * server sends `Me.email`, that is when the club has a mail provider (DEPLOY.md §4.14)
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Status = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  overflow-wrap: anywhere;
`

export function EmailCard() {
  const { t, lang, message } = usePreferences()
  const e = t.email
  const toast = useToast()
  const { user, refresh } = useAuth()
  const id = useId()
  const [address, setAddress] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const email = user?.email
  if (!email) return null

  const run = async (act: () => Promise<string>) => {
    setError('')
    setBusy(true)
    try {
      toast.success(await act())
      setPassword('')
      setAddress('')
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const wanted = address.trim()
    void run(() => api.setEmail(wanted, password, lang).then(() => e.sent(wanted.toLowerCase())))
  }
  const remove = () => {
    if (!password) {
      setError(e.passwordFirst)
      return
    }
    if (!window.confirm(e.removeConfirm)) return
    void run(() => api.setEmail('', password, lang).then(() => e.removed))
  }

  return (
    <Card as="form" onSubmit={submit} aria-label={e.title}>
      <CardHeader>
        <CardTitle>{e.title}</CardTitle>
      </CardHeader>
      <Stack>
        <Muted>{e.intro}</Muted>
        <Status role="status">{email.address ? e.verified(email.address) : e.none}</Status>
        {email.pending && <Muted>{e.pending(email.pending)}</Muted>}
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Field>
          <FieldLabel htmlFor={`${id}-address`}>{e.newAddress}</FieldLabel>
          <Input
            id={`${id}-address`}
            type="email"
            value={address}
            autoComplete="email"
            maxLength={254}
            onChange={(ev) => setAddress(ev.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>{e.password}</FieldLabel>
          <PasswordInput
            id={`${id}-password`}
            value={password}
            autoComplete="current-password"
            onChange={(ev) => setPassword(ev.target.value)}
            required
          />
        </Field>
      </Stack>
      <CardFooter>
        <Button type="submit" $variant="primary" $busy={busy}>
          {e.send}
        </Button>
        {email.pending && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => void run(() => api.resendEmailVerification(lang).then(() => e.sent(email.pending!)))}
          >
            {e.resend}
          </Button>
        )}
        {(email.address || email.pending) && (
          <Button type="button" $variant="danger" disabled={busy} onClick={remove}>
            {e.remove}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
