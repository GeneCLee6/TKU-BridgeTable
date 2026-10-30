import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import type { SessionInfo } from '../../shared/account.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { PasswordInput } from './PasswordInput.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Muted } from './ui.tsx'

/**
 * "My account"'s security and privacy cards: where the member is signed in, with signing other
 * devices out (e11-t23), and their own data: downloading it and deleting the account (e11-t27)
 */

const List = styled.ul`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: ${({ theme }) => theme.space(4)} 0 0;
  padding: 0;
  list-style: none;
`

const Row = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(2)};

  & strong {
    display: block;
    color: ${({ theme }) => theme.colors.text};
  }
  & small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.small.size};
  }
`

const Tag = styled.span`
  margin-left: ${({ theme }) => theme.space(2)};
  color: ${({ theme }) => theme.colors.accent};
  font-size: ${({ theme }) => theme.type.small.size};
  font-weight: 600;
`

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

export function SessionsCard() {
  const { t, lang, message } = usePreferences()
  const s = t.security
  const toast = useToast()
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const text = useCallback(
    (e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError),
    [message, t],
  )

  const load = useCallback(
    () =>
      api
        .sessions()
        .then(({ sessions }) => setSessions(sessions))
        .catch((e) => setError(text(e))),
    [text],
  )
  useEffect(() => {
    void load()
  }, [load])

  const act = async (run: () => Promise<string>) => {
    setBusy(true)
    try {
      toast.success(await run())
      await load()
    } catch (e) {
      toast.error(text(e))
    } finally {
      setBusy(false)
    }
  }
  const others = sessions?.filter((x) => !x.current) ?? []

  return (
    <Card aria-label={s.sessionsTitle}>
      <CardHeader>
        <CardTitle>{s.sessionsTitle}</CardTitle>
      </CardHeader>
      <Muted>{s.sessionsIntro}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {sessions && (
        <List>
          {sessions.map((session) => {
            const device = session.device || s.unknownDevice
            return (
              <Row key={session.id}>
                <span>
                  <strong>
                    {device}
                    {session.current && <Tag>{s.thisDevice}</Tag>}
                  </strong>
                  <small>{s.sessionTimes(formatDateTime(session.createdAt, lang), formatDateTime(session.lastSeenAt, lang))}</small>
                </span>
                {!session.current && (
                  <Button
                    type="button"
                    $size="sm"
                    disabled={busy}
                    aria-label={s.signOutLabel(device)}
                    onClick={() => void act(() => api.endSession(session.id).then(() => s.signedOutOne))}
                  >
                    {s.signOut}
                  </Button>
                )}
              </Row>
            )
          })}
        </List>
      )}
      {sessions && !others.length && <Muted>{s.noOtherSessions}</Muted>}
      <CardFooter>
        <Button
          type="button"
          $busy={busy}
          disabled={!others.length}
          onClick={() => void act(() => api.endOtherSessions().then(({ ended }) => s.signedOutOthers(ended)))}
        >
          {s.signOutOthers}
        </Button>
      </CardFooter>
    </Card>
  )
}

export function DataCard() {
  const { t, message } = usePreferences()
  const s = t.security
  const toast = useToast()
  const { refresh } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!window.confirm(s.deleteConfirm)) return
    setError('')
    setBusy(true)
    try {
      await api.deleteAccount(password)
      toast.success(s.deleted)
      // The answer cleared the cookies: the page shows the sign-in again
      await refresh()
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
      setBusy(false)
    }
  }

  return (
    <>
      <Card aria-label={s.dataTitle}>
        <CardHeader>
          <CardTitle>{s.dataTitle}</CardTitle>
        </CardHeader>
        <Muted>{s.dataIntro}</Muted>
        <CardFooter>
          <Button as="a" href={api.exportUrl} download>
            {s.exportData}
          </Button>
        </CardFooter>
      </Card>
      <Card as="form" onSubmit={submit} aria-label={s.deleteTitle}>
        <CardHeader>
          <CardTitle>{s.deleteTitle}</CardTitle>
        </CardHeader>
        <Stack>
          <Muted>{s.deleteIntro}</Muted>
          {error && <ErrorText role="alert">{error}</ErrorText>}
          <Field>
            <FieldLabel htmlFor={`${id}-password`}>{s.deletePassword}</FieldLabel>
            <PasswordInput
              id={`${id}-password`}
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
        </Stack>
        <CardFooter>
          <Button type="submit" $variant="danger" $busy={busy}>
            {s.deleteButton}
          </Button>
        </CardFooter>
      </Card>
    </>
  )
}
