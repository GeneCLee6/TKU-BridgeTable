import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { api, ApiError } from '../lib/api.ts'
import { leave } from '../lib/leave.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import type { OAuthName } from '../../shared/protocol.ts'
import { PasswordInput } from './PasswordInput.tsx'
import { SignInButton } from './SignInButtons.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Muted } from './ui.tsx'

/**
 * "My account"'s Google sign-in (e1-t31) or LINE login (e1-t32), one card each: the account bound
 * to this one (Google's address or the LINE name, only the owner sees it), binding one (the password
 * first, then the provider's own branded button) and unbinding it (with the password; the password
 * keeps working). Shown only when the server sends `Me.google` / `Me.line`, that is when the club
 * has that provider (DEPLOY.md §4.16, §4.17). The provider sends the browser back here with
 * `?google=linked` or `?line=error&code=…`, which the card reports once
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

/** What the provider's way back said, read once when the page opens */
function backFrom(provider: OAuthName): { step: string | null; code: string } {
  const params = new URLSearchParams(window.location.search)
  return { step: params.get(provider), code: params.get('code') ?? '' }
}

export function OAuthCard({ provider }: { provider: OAuthName }) {
  const { t, message } = usePreferences()
  const g = t[provider]
  const toast = useToast()
  const { user, refresh } = useAuth()
  const id = useId()
  const [password, setPassword] = useState('')
  const [back] = useState(() => backFrom(provider))
  const [error, setError] = useState(() => (back.step === 'error' ? message(back.code, {}, t.genericError) : ''))
  const [busy, setBusy] = useState(false)
  const told = useRef(false)

  useEffect(() => {
    if (!back.step || told.current) return
    told.current = true
    window.history.replaceState(null, '', window.location.pathname)
    if (back.step === 'linked') toast.success(g.linkedDone)
  }, [back, g, toast])

  const label = provider === 'google' ? user?.google?.email : user?.line?.name
  if (user?.[provider] === undefined) return null

  const fail = (err: unknown) => setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)

  const link = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      leave.to((await api[provider].link(password)).url)
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
      await api[provider].unlink(password)
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
        <Status role="status">{user[provider] ? g.linked(label ?? '') : g.none}</Status>
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
        {user[provider] ? (
          <Button type="button" $variant="danger" disabled={busy} onClick={() => void unlink()}>
            {g.unlink}
          </Button>
        ) : (
          <SignInButton provider={provider} type="submit" busy={busy} inline>
            {g.link}
          </SignInButton>
        )}
      </CardFooter>
    </Card>
  )
}
