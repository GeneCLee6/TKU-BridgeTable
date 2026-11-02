import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { api, ApiError } from '../lib/api.ts'
import { leave } from '../lib/leave.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { PasswordInput } from './PasswordInput.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Muted } from './ui.tsx'

/**
 * "My account"'s Google sign-in (e1-t31): the Google account bound to this one (its address, only
 * the owner sees it), binding one (the password first, then Google) and unbinding it (with the
 * password; the password keeps working). Shown only when the server sends `Me.google`, that is when
 * the club has Google sign-in (DEPLOY.md §4.16). Google sends the browser back here with
 * `?google=linked` or `?google=error&code=…`, which this card reports once
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

/** What Google's way back said, read once when the page opens */
function googleBack(): { step: string | null; code: string } {
  const params = new URLSearchParams(window.location.search)
  return { step: params.get('google'), code: params.get('code') ?? '' }
}

export function GoogleCard() {
  const { t, message } = usePreferences()
  const g = t.google
  const toast = useToast()
  const { user, refresh } = useAuth()
  const id = useId()
  const [password, setPassword] = useState('')
  const [back] = useState(googleBack)
  const [error, setError] = useState(() => (back.step === 'error' ? message(back.code, {}, t.genericError) : ''))
  const [busy, setBusy] = useState(false)
  const told = useRef(false)

  useEffect(() => {
    if (!back.step || told.current) return
    told.current = true
    window.history.replaceState(null, '', window.location.pathname)
    if (back.step === 'linked') toast.success(g.linkedDone)
  }, [back, g, toast])

  const google = user?.google
  if (google === undefined) return null

  const fail = (err: unknown) => setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)

  const link = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      leave.to((await api.google.link(password)).url)
    } catch (err) {
      fail(err)
      setBusy(false)
    }
  }

  const unlink = async () => {
    if (!password) return setError(g.passwordFirst)
    if (!window.confirm(g.unlinkConfirm)) return
    setError('')
    setBusy(true)
    try {
      await api.google.unlink(password)
      setPassword('')
      toast.success(g.unlinked)
      await refresh()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card as="form" onSubmit={link} aria-label={g.title}>
      <CardHeader>
        <CardTitle>{g.title}</CardTitle>
      </CardHeader>
      <Stack>
        <Muted>{g.intro}</Muted>
        <Status role="status">{google ? g.linked(google.email) : g.none}</Status>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Field>
          <FieldLabel htmlFor={`${id}-password`}>{g.password}</FieldLabel>
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
        {google ? (
          <Button type="button" $variant="danger" disabled={busy} onClick={() => void unlink()}>
            {g.unlink}
          </Button>
        ) : (
          <Button type="submit" $variant="primary" $busy={busy}>
            {g.link}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
