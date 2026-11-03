import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import styled from 'styled-components'
import { PROFILE_LIMITS } from '../../shared/profile.ts'
import { LIMITS, type OAuthName } from '../../shared/protocol.ts'
import { CredentialInput } from '../components/CredentialInput.tsx'
import { LogoMark } from '../components/Logo.tsx'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { SignInButton } from '../components/SignInButtons.tsx'
import { Turnstile } from '../components/Turnstile.tsx'
import { Button, Card, ErrorText, Field, FieldError, FieldHint, FieldLabel, Input, Muted } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { api, ApiError } from '../lib/api.ts'
import { leave } from '../lib/leave.ts'
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

/** 或 between the form and the Google and LINE buttons, with a rule on each side */
const Or = styled.p`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.small.size};

  &::before,
  &::after {
    content: '';
    flex: 1;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
`

const PROVIDERS: readonly OAuthName[] = ['google', 'line']

/**
 * Where Google or LINE sent the browser back to (e1-t31, e1-t32): `?google=code|apply|error&code=…`
 * or the same with `?line=`, read once
 */
function oauthReturn(): { provider: OAuthName; step: 'code' | 'apply' | 'error' | null; code: string } {
  const params = new URLSearchParams(window.location.search)
  const provider = PROVIDERS.find((p) => params.has(p)) ?? 'google'
  const step = params.get(provider)
  return {
    provider,
    step: step === 'code' || step === 'apply' || step === 'error' ? step : null,
    code: params.get('code') ?? '',
  }
}

/** A button for each provider the club has, in a stack */
const Providers = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
`

const Footnote = styled(Muted)`
  text-align: center;
  font-size: 13px;
`

/**
 * `reset` asks the admins (with the invite code), `resetCode` sets the password with the code they
 * handed over (e1-t36); `emailReset` mails a link to the account's verified address (e1-t30)
 */
type Mode = 'login' | 'register' | 'reset' | 'resetCode' | 'emailReset' | 'oauthCode'
type FieldName = 'username' | 'password' | 'repeat' | 'inviteCode' | 'code' | 'otp' | 'displayName'

/** Server error codes that belong to one field; the rest show above the form */
const FIELD_OF: Record<string, FieldName> = {
  badUsername: 'username',
  usernameTaken: 'username',
  shortPassword: 'password',
  longPassword: 'password',
  passwordHasUsername: 'password',
  commonPassword: 'password',
  profileNameTooLong: 'displayName',
  badInvite: 'inviteCode',
  resetCodeWrong: 'code',
}

/**
 * Sign in, 申請加入 and 忘記密碼 (DESIGN.md §7.8, docs/design/01-login.png). Applying sends an
 * application that an admin approves on the admin page (only the club's first account signs in at
 * once); the account then works on both TKU BridgeTable and TKU BridgeBook. 忘記密碼 is two steps
 * (e1-t36): ask the admins, then enter the one-time code an admin hands over with a new password.
 * With Google sign-in (e1-t31) or LINE login (e1-t32) on there is a branded button for each: the
 * provider sends the browser back here with `?google=` or `?line=` when the account has 兩步驟登入
 * (the code step, `oauthCode`), when its account has no club account (the application form, the
 * provider's name filling in the display name) or on an error.
 */
export function LoginPage() {
  const t = useT()
  const { message, lang } = usePreferences()
  const { login, register, refresh } = useAuth()
  const id = useId()
  /** Where Google or LINE sent the browser back to (e1-t31, e1-t32), read once */
  const [back] = useState(oauthReturn)
  const [mode, setMode] = useState<Mode>(back.step === 'code' ? 'oauthCode' : 'login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [code, setCode] = useState('')
  /** 兩步驟登入 (e11-t31): set once the server answers that this account needs a code, and the code typed */
  const [needOtp, setNeedOtp] = useState(false)
  const [otp, setOtp] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState(() => (back.step === 'error' ? message(back.code, {}, t.genericError) : ''))
  const [fieldError, setFieldError] = useState<{ field: FieldName; text: string } | null>(null)
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  /** Turnstile on 申請加入 (e1-t33): its site key once the Worker says it is on, and the current token */
  const [siteKey, setSiteKey] = useState<string | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileReset, setTurnstileReset] = useState(0)
  /** Google sign-in and LINE login (e1-t31, e1-t32): which are on, the one an application uses, and its display name */
  const [providersOn, setProvidersOn] = useState<Record<OAuthName, boolean>>({ google: false, line: false })
  const [applyWith, setApplyWith] = useState<OAuthName | null>(null)
  const [displayName, setDisplayName] = useState('')

  /** Whether the club sends mail (e1-t29): only then is there 忘記密碼 by email */
  const [emailOn, setEmailOn] = useState(false)
  useEffect(() => {
    let live = true
    api
      .emailStatus()
      .then(({ enabled }) => live && setEmailOn(enabled))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    let live = true
    for (const provider of PROVIDERS)
      api[provider]
        .status()
        .then(({ enabled }) => live && setProvidersOn((on) => ({ ...on, [provider]: enabled })))
        .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  // Back from Google or LINE: the code step, the application form with the provider's name, or what went wrong
  useEffect(() => {
    if (!back.step) return
    let live = true
    window.history.replaceState(null, '', window.location.pathname)
    if (back.step === 'apply')
      api[back.provider]
        .pending()
        .then((pending) => {
          if (!live) return
          if (pending.step !== 'apply') return setError(message(`${back.provider}Failed`, {}, t.genericError))
          setMode('register')
          setApplyWith(back.provider)
          setDisplayName(pending.name)
        })
        .catch(() => live && setError(t.genericError))
    return () => {
      live = false
    }
  }, [back, message, t])

  const startOAuth = async (provider: OAuthName) => {
    setError('')
    setBusy(true)
    try {
      leave.to((await api[provider].start(window.location.pathname + window.location.search)).url)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)
      setBusy(false)
    }
  }

  const registering = mode === 'register'
  const oauthCode = mode === 'oauthCode'
  /** The provider of the code step, or of the application in progress */
  const via = applyWith ?? back.provider
  const resetting = mode === 'reset'
  const withCode = mode === 'resetCode'
  const emailing = mode === 'emailReset'
  const title = registering
    ? t.register
    : resetting
      ? t.resetTitle
      : withCode
        ? t.enterResetCode
        : emailing
          ? t.email.resetTitle
          : oauthCode
            ? t[via].codeTitle
            : t.login
  const intro = registering
    ? t.registerIntro
    : resetting
      ? t.resetIntro
      : withCode
        ? t.resetCodeIntro
        : emailing
          ? t.email.resetIntro
          : oauthCode
            ? t[via].codeIntro
            : t.loginIntro
  const submitLabel = resetting ? t.resetRequestButton : emailing ? t.email.sendLink : oauthCode ? t.login : title
  /** Who signs in or registers types a password; asking for a reset (or the code step after Google or LINE) does not */
  const needsPassword = !resetting && !emailing && !oauthCode
  const newPassword = registering || withCode

  useEffect(() => {
    if (!registering || siteKey !== null) return
    let cancelled = false
    api.registerOptions().then(
      (options) => !cancelled && setSiteKey(options.turnstileSiteKey ?? ''),
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [registering, siteKey])
  const needsTurnstile = registering && !!siteKey

  const switchTo = (next: Mode) => {
    setMode(next)
    setError('')
    setFieldError(null)
    setDone('')
    setPassword('')
    setRepeat('')
    setNeedOtp(false)
    setOtp('')
    setApplyWith(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    setFieldError(null)
    if (withCode && password !== repeat) {
      setFieldError({ field: 'repeat', text: t.passwordMismatch })
      return
    }
    if (needsTurnstile && !turnstileToken) {
      setError(t.captchaNeeded)
      return
    }
    setBusy(true)
    try {
      if (oauthCode) {
        // The code step after Google or LINE (e1-t31, e1-t32): signed in, back to where the member was
        const { returnTo } = await api[via].code(otp, lang)
        window.history.replaceState(null, '', returnTo)
        await refresh()
      } else if (registering) {
        const result = await register(
          username,
          password,
          inviteCode,
          note,
          needsTurnstile ? turnstileToken : undefined,
          applyWith ? { provider: applyWith, displayName } : undefined,
        )
        if ('pending' in result) setDone(t.applicationSent(result.username))
      } else if (resetting) {
        await api.requestPasswordReset(username, inviteCode)
        setDone(t.resetRequested)
      } else if (emailing) {
        await api.requestEmailReset(username, lang)
        setDone(t.email.linkSent)
      } else if (withCode) {
        await api.resetPassword(username, code, password)
        switchTo('login')
        setCode('')
        setDone(t.resetDone)
      } else await login(username, password, needOtp ? otp : undefined, lang)
    } catch (e) {
      // The right password for an account with the second step: ask for the code, no error
      if (e instanceof ApiError && e.code === 'twoFactorNeeded') {
        setNeedOtp(true)
        return
      }
      // The code step after Google or LINE ran out: start again from the sign-in form
      const flowGone = e instanceof ApiError && e.code === `${via}Failed`
      if (oauthCode && flowGone) switchTo('login')
      if (flowGone) setApplyWith(null)
      const text = e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError
      const field =
        e instanceof ApiError ? (e.code === 'twoFactorWrong' ? 'otp' : mode !== 'login' ? FIELD_OF[e.code] : undefined) : undefined
      if (field) setFieldError({ field, text })
      else setError(text)
      // A Turnstile token is good for one try
      if (needsTurnstile) setTurnstileReset((n) => n + 1)
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
            {registering && applyWith && <Done role="status">{t[applyWith].applyNotice}</Done>}
            {!oauthCode && (
              <Field>
                <FieldLabel htmlFor={`${id}-username`}>{emailing ? t.email.account : t.username}</FieldLabel>
                <CredentialInput
                  {...describe('username', registering)}
                  $size="lg"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  inputMode={emailing ? 'email' : 'text'}
                  autoComplete={emailing ? 'email' : 'username'}
                  required
                  minLength={emailing ? undefined : LIMITS.usernameMin}
                  maxLength={emailing ? 254 : LIMITS.usernameMax}
                />
                {below('username', registering && t.usernameHint(LIMITS.usernameMin, LIMITS.usernameMax))}
              </Field>
            )}
            {registering && applyWith && (
              <Field>
                <FieldLabel htmlFor={`${id}-displayName`}>{t[applyWith].displayName}</FieldLabel>
                <Input
                  {...describe('displayName', true)}
                  $size="lg"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={PROFILE_LIMITS.displayNameMax}
                  autoComplete="nickname"
                />
                {below('displayName', t[applyWith].displayNameHint)}
              </Field>
            )}
            {withCode && (
              <Field>
                <FieldLabel htmlFor={`${id}-code`}>{t.resetCode}</FieldLabel>
                <CredentialInput
                  {...describe('code', true)}
                  $size="lg"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  required
                  maxLength={20}
                />
                {below('code', t.resetCodeHint)}
              </Field>
            )}
            {needsPassword && (
              <Field>
                <LabelRow>
                  <FieldLabel htmlFor={`${id}-password`}>{withCode ? t.newPassword : t.password}</FieldLabel>
                  {mode === 'login' && (
                    <LinkButton type="button" onClick={() => switchTo(emailOn ? 'emailReset' : 'reset')}>
                      {t.forgotPassword}
                    </LinkButton>
                  )}
                </LabelRow>
                <PasswordInput
                  {...describe('password', newPassword)}
                  $size="lg"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={newPassword ? 'new-password' : 'current-password'}
                  required
                  minLength={newPassword ? LIMITS.passwordMin : undefined}
                />
                {below('password', newPassword && t.passwordHint(LIMITS.passwordMin))}
              </Field>
            )}
            {((mode === 'login' && needOtp) || oauthCode) && (
              <Field>
                <FieldLabel htmlFor={`${id}-otp`}>{t.twoFactor.code}</FieldLabel>
                <CredentialInput
                  {...describe('otp', true)}
                  $size="lg"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  maxLength={20}
                />
                {below('otp', t.twoFactor.loginHint)}
              </Field>
            )}
            {withCode && (
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
            {(registering || resetting) && (
              <Field>
                <FieldLabel htmlFor={`${id}-inviteCode`}>{t.inviteCode}</FieldLabel>
                <CredentialInput
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
            {needsTurnstile && siteKey && <Turnstile siteKey={siteKey} resetKey={turnstileReset} onToken={setTurnstileToken} />}
            <Button type="submit" $variant="primary" $size="lg" $busy={busy}>
              {submitLabel}
            </Button>
            {PROVIDERS.some((p) => providersOn[p]) && (mode === 'login' || (registering && !applyWith)) && (
              <>
                <Or>{t.google.or}</Or>
                <Providers>
                  {PROVIDERS.filter((p) => providersOn[p]).map((provider) => (
                    <SignInButton key={provider} provider={provider} disabled={busy} onClick={() => void startOAuth(provider)}>
                      {registering ? t[provider].apply : t[provider].signIn}
                    </SignInButton>
                  ))}
                </Providers>
              </>
            )}
          </Form>
        )}
        <Switch>
          {emailing ? (
            <>
              <LinkButton type="button" onClick={() => switchTo('reset')}>
                {t.email.byAdmin}
              </LinkButton>
              {' · '}
              <LinkButton type="button" onClick={() => switchTo('login')}>
                {t.backToLogin}
              </LinkButton>
            </>
          ) : oauthCode ? (
            <LinkButton type="button" onClick={() => switchTo('login')}>
              {t[via].usePassword}
            </LinkButton>
          ) : resetting || withCode ? (
            <>
              {resetting && emailOn && (
                <>
                  {t.email.haveEmail}{' '}
                  <LinkButton type="button" onClick={() => switchTo('emailReset')}>
                    {t.email.resetByEmail}
                  </LinkButton>
                  {' · '}
                </>
              )}
              {resetting && (
                <>
                  {t.haveResetCode}{' '}
                  <LinkButton type="button" onClick={() => switchTo('resetCode')}>
                    {t.enterResetCode}
                  </LinkButton>
                  {' · '}
                </>
              )}
              <LinkButton type="button" onClick={() => switchTo('login')}>
                {t.backToLogin}
              </LinkButton>
            </>
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
