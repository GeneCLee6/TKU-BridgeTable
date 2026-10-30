import { useId, useState, type FormEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import { LIMITS } from '../../shared/protocol.ts'
import { LogoMark } from '../components/Logo.tsx'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { Button, Card, ErrorText, Field, FieldError, FieldHint, FieldLabel, Input, Muted } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { api, ApiError } from '../lib/api.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'

const Wrap = styled.main`
  display: grid;
  align-content: center;
  justify-items: center;
  gap: ${({ theme }) => theme.space(4)};
  min-height: calc(100vh - ${({ theme }) => theme.layout.headerHeight});
  padding: ${({ theme }) => theme.space(8)} 16px;
`

/** DESIGN.md §7.8: 420 wide, 32 inside, a 3px lantern-gold rule along the top */
const Panel = styled(Card)`
  --card-pad: ${({ theme }) => theme.space(8)};
  width: min(100%, 420px);
  display: grid;
  gap: ${({ theme }) => theme.space(5)};
  border-top: 3px solid ${({ theme }) => theme.colors.accent};

  ${mobile} {
    --card-pad: ${({ theme }) => theme.space(5)};
  }
`

const Brand = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};

  & strong {
    display: block;
    color: ${({ theme }) => theme.colors.text};
    font-size: 15px;
    line-height: 20px;
  }
  & small {
    display: block;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.caption.size};
    line-height: ${({ theme }) => theme.type.caption.line};
    font-weight: 400;
  }
`

const Heading = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(1)};

  & > h1 {
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.title.size};
    line-height: ${({ theme }) => theme.type.title.line};
    font-weight: ${({ theme }) => theme.type.title.weight};
  }
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

/** The password label with 忘記密碼？ on its right */
const LabelRow = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(2)};
`

/** A button that reads as a link: it switches the form, it doesn't leave the page */
const LinkButton = styled.button`
  padding: 0;
  border: 0;
  background: none;
  color: ${({ theme }) => theme.colors.primary};
  font: inherit;
  font-size: ${({ theme }) => theme.type.small.size};
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.primaryHover};
  }
  &:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: 2px;
    border-radius: 2px;
  }
`

const Switch = styled.p`
  margin: 0;
  padding-top: ${({ theme }) => theme.space(4)};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.textMuted};
  text-align: center;
  font-size: 14px;
`

const Done = styled.p`
  margin: 0;
  padding: 10px 12px;
  border-left: 4px solid ${({ theme }) => theme.colors.success};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.successSoft};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  line-height: 1.6;
`

const Footnote = styled(Muted)`
  text-align: center;
  font-size: 13px;
`

type Mode = 'login' | 'register' | 'reset'
type FieldName = 'username' | 'password' | 'repeat' | 'inviteCode'

/** Server error codes that belong to one field; the rest show above the form */
const FIELD_OF: Record<string, FieldName> = {
  badUsername: 'username',
  usernameTaken: 'username',
  shortPassword: 'password',
  longPassword: 'password',
  badInvite: 'inviteCode',
}

/**
 * Sign in, 申請加入 and 忘記密碼 (DESIGN.md §7.8, docs/design/01-login.png). Applying sends an
 * application that an admin approves on the admin page (only the club's first account signs in at
 * once); the account then works on both TKU BridgeTable and TKU BridgeBook.
 */
export function LoginPage() {
  const t = useT()
  const { message } = usePreferences()
  const { login, register } = useAuth()
  const id = useId()
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState<{ field: FieldName; text: string } | null>(null)
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  const registering = mode === 'register'
  const resetting = mode === 'reset'
  const title = registering ? t.register : resetting ? t.resetTitle : t.login
  const intro = registering ? t.registerIntro : resetting ? t.resetIntro : t.loginIntro

  const switchTo = (next: Mode) => {
    setMode(next)
    setError('')
    setFieldError(null)
    setDone('')
    setPassword('')
    setRepeat('')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setFieldError(null)
    if (resetting && password !== repeat) {
      setFieldError({ field: 'repeat', text: t.passwordMismatch })
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
      const text = e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError
      const field = e instanceof ApiError && mode !== 'login' ? FIELD_OF[e.code] : undefined
      if (field) setFieldError({ field, text })
      else setError(text)
    } finally {
      setBusy(false)
    }
  }

  /** The ids and ARIA that tie one input to its hint or error */
  const describe = (field: FieldName, hint: boolean) => {
    const invalid = fieldError?.field === field
    const describedBy = invalid ? `${id}-${field}-error` : hint ? `${id}-${field}-hint` : undefined
    return { id: `${id}-${field}`, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy }
  }
  const below = (field: FieldName, hint?: ReactNode) =>
    fieldError?.field === field ? (
      <FieldError id={`${id}-${field}-error`} role="alert">
        {fieldError.text}
      </FieldError>
    ) : hint ? (
      <FieldHint id={`${id}-${field}-hint`}>{hint}</FieldHint>
    ) : null

  return (
    <Wrap>
      <Panel>
        <Brand>
          <LogoMark size={40} />
          <span>
            <strong>{t.appNameZh}</strong>
            <small>{t.loginBrandSub}</small>
          </span>
        </Brand>
        <Heading>
          <h1>{title}</h1>
          <Muted>{intro}</Muted>
        </Heading>
        {done && registering ? (
          <>
            <Done role="status">{done}</Done>
            <Button type="button" $variant="primary" $size="lg" onClick={() => switchTo('login')}>
              {t.backToLogin}
            </Button>
          </>
        ) : (
          <Form onSubmit={submit} aria-label={title}>
            {error && <ErrorText role="alert">{error}</ErrorText>}
            {done && <Done role="status">{done}</Done>}
            <Field>
              <FieldLabel htmlFor={`${id}-username`}>{t.username}</FieldLabel>
              <Input
                {...describe('username', registering)}
                $size="lg"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
                minLength={LIMITS.usernameMin}
                maxLength={LIMITS.usernameMax}
              />
              {below('username', registering && t.usernameHint(LIMITS.usernameMin, LIMITS.usernameMax))}
            </Field>
            <Field>
              <LabelRow>
                <FieldLabel htmlFor={`${id}-password`}>{resetting ? t.newPassword : t.password}</FieldLabel>
                {mode === 'login' && (
                  <LinkButton type="button" onClick={() => switchTo('reset')}>
                    {t.forgotPassword}
                  </LinkButton>
                )}
              </LabelRow>
              <PasswordInput
                {...describe('password', mode !== 'login')}
                $size="lg"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'login' ? undefined : LIMITS.passwordMin}
              />
              {below('password', mode !== 'login' && t.passwordHint(LIMITS.passwordMin))}
            </Field>
            {resetting && (
              <Field>
                <FieldLabel htmlFor={`${id}-repeat`}>{t.confirmPassword}</FieldLabel>
                <PasswordInput
                  {...describe('repeat', false)}
                  $size="lg"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                {below('repeat')}
              </Field>
            )}
            {mode !== 'login' && (
              <Field>
                <FieldLabel htmlFor={`${id}-inviteCode`}>{t.inviteCode}</FieldLabel>
                <Input
                  {...describe('inviteCode', true)}
                  $size="lg"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="off"
                />
                {below('inviteCode', t.inviteHint)}
              </Field>
            )}
            {registering && (
              <Field>
                <FieldLabel htmlFor={`${id}-note`}>{t.applicationNote}</FieldLabel>
                <Input
                  id={`${id}-note`}
                  aria-describedby={`${id}-note-hint`}
                  $size="lg"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={LIMITS.applicationNoteMax}
                  autoComplete="off"
                />
                <FieldHint id={`${id}-note-hint`}>{t.applicationNoteHint}</FieldHint>
              </Field>
            )}
            <Button type="submit" $variant="primary" $size="lg" $busy={busy}>
              {title}
            </Button>
          </Form>
        )}
        <Switch>
          {resetting ? (
            <LinkButton type="button" onClick={() => switchTo('login')}>
              {t.backToLogin}
            </LinkButton>
          ) : (
            <>
              {registering ? t.haveAccount : t.noAccount}{' '}
              <LinkButton type="button" onClick={() => switchTo(registering ? 'login' : 'register')}>
                {registering ? t.login : t.register}
              </LinkButton>
            </>
          )}
        </Switch>
      </Panel>
      <Footnote>{t.sharedAccountHint}</Footnote>
      <Footnote>
        {registering && <>{t.legal.agree} </>}
        <a href="/privacy">{t.legal.privacyTitle}</a>
        {' · '}
        <a href="/terms">{t.legal.termsTitle}</a>
      </Footnote>
    </Wrap>
  )
}
