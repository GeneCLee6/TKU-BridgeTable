import { useEffect, useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { CLUB_APPLICATION_LIMITS, clubIdProblem } from '../../shared/platform.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { Turnstile } from '../components/Turnstile.tsx'
import { Button, Card, ErrorText, Field, FieldError, FieldHint, FieldLabel, Input, Muted, PageMain, PageTitle, Textarea } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { homePath } from '../lib/club.ts'
import { useSignedIn } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 申請開設社團 (e12-t06, `/clubs/apply`): a club officer asks for a club of its own, signed in or
 * not. The account set up here is the new club's first admin once the platform owner approves it
 * (worker/platform.ts); every check is the server's, the page only says what it found
 */

const Panel = styled(Card)`
  width: min(100%, 560px);
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
  border-top: 3px solid ${({ theme }) => theme.colors.accent};
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Group = styled.fieldset`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};

  legend {
    padding: 0 4px;
    font-weight: 600;
  }
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

const EMPTY = { clubId: '', name: '', organisation: '', contactEmail: '', reason: '', username: '', password: '' }
type Fields = typeof EMPTY

export function ClubApplyPage() {
  const { t, lang, message } = usePreferences()
  const signedIn = useSignedIn()
  const a = t.clubApply
  const id = useId()
  const [open, setOpen] = useState<boolean | null>(null)
  const [siteKey, setSiteKey] = useState('')
  const [token, setToken] = useState('')
  const [reset, setReset] = useState(0)
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [error, setError] = useState('')
  const [idError, setIdError] = useState('')
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.clubApply.options().then(
      (options) => {
        if (cancelled) return
        setOpen(options.open)
        setSiteKey(options.turnstileSiteKey ?? '')
      },
      () => !cancelled && setOpen(false),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const set = (key: keyof Fields) => (event: { target: { value: string } }) => setFields((f) => ({ ...f, [key]: event.target.value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    const problem = clubIdProblem(fields.clubId.trim().toLowerCase())
    setIdError(problem ? message(problem, {}) : '')
    if (problem) return
    if (siteKey && !token) {
      setError(t.captchaNeeded)
      return
    }
    setBusy(true)
    try {
      const { clubId } = await api.clubApply.send({ ...fields, lang, ...(siteKey && { turnstileToken: token }) })
      setDone(a.sent(clubId))
    } catch (err) {
      const text = err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError
      if (err instanceof ApiError && ['badClubId', 'clubIdReserved', 'clubIdTaken'].includes(err.code)) setIdError(text)
      else setError(text)
      // A Turnstile token is good for one try
      if (siteKey) setReset((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  const L = CLUB_APPLICATION_LIMITS
  return (
    <PageMain>
      <PageTitle>{a.title}</PageTitle>
      <Panel>
        {done ? (
          <Done role="status">{done}</Done>
        ) : open === null ? (
          <Muted>{t.loading}</Muted>
        ) : !open ? (
          <Muted role="status">{a.closed}</Muted>
        ) : (
          <Form onSubmit={submit} aria-label={a.title} noValidate>
            <Muted>{a.intro}</Muted>
            {error && <ErrorText role="alert">{error}</ErrorText>}
            <Field>
              <FieldLabel htmlFor={`${id}-club`}>{a.clubId}</FieldLabel>
              <Input
                id={`${id}-club`}
                value={fields.clubId}
                onChange={set('clubId')}
                aria-invalid={!!idError || undefined}
                aria-describedby={`${id}-club-hint${idError ? ` ${id}-club-error` : ''}`}
                autoCapitalize="none"
                spellCheck={false}
                required
              />
              <FieldHint id={`${id}-club-hint`}>{a.clubIdHint}</FieldHint>
              {idError && (
                <FieldError id={`${id}-club-error`} role="alert">
                  {idError}
                </FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{a.name}</FieldLabel>
              <Input id={`${id}-name`} value={fields.name} onChange={set('name')} maxLength={L.nameMax} required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-org`}>{a.org}</FieldLabel>
              <Input id={`${id}-org`} value={fields.organisation} onChange={set('organisation')} maxLength={L.organisationMax} required />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>{a.email}</FieldLabel>
              <Input
                id={`${id}-email`}
                type="email"
                value={fields.contactEmail}
                onChange={set('contactEmail')}
                aria-describedby={`${id}-email-hint`}
                autoComplete="email"
                required
              />
              <FieldHint id={`${id}-email-hint`}>{a.emailHint}</FieldHint>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-reason`}>{a.reason}</FieldLabel>
              <Textarea
                id={`${id}-reason`}
                value={fields.reason}
                onChange={set('reason')}
                aria-describedby={`${id}-reason-hint`}
                maxLength={L.reasonMax}
                rows={4}
                required
              />
              <FieldHint id={`${id}-reason-hint`}>{a.reasonHint(L.reasonMin, L.reasonMax)}</FieldHint>
            </Field>
            <Group>
              <legend>{a.account}</legend>
              <Muted>{a.accountHint}</Muted>
              <Field>
                <FieldLabel htmlFor={`${id}-user`}>{a.username}</FieldLabel>
                <Input
                  id={`${id}-user`}
                  value={fields.username}
                  onChange={set('username')}
                  autoComplete="off"
                  autoCapitalize="none"
                  maxLength={LIMITS.usernameMax}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>{a.password}</FieldLabel>
                <PasswordInput
                  id={`${id}-password`}
                  value={fields.password}
                  onChange={set('password')}
                  aria-describedby={`${id}-password-hint`}
                  autoComplete="new-password"
                  minLength={LIMITS.passwordMin}
                  required
                />
                <FieldHint id={`${id}-password-hint`}>{t.passwordHint(LIMITS.passwordMin)}</FieldHint>
              </Field>
            </Group>
            {siteKey && <Turnstile siteKey={siteKey} resetKey={reset} onToken={setToken} />}
            <Button type="submit" $variant="primary" $size="lg" $busy={busy}>
              {a.send}
            </Button>
          </Form>
        )}
        <a href={homePath(signedIn)}>{a.toSite}</a>
      </Panel>
    </PageMain>
  )
}
