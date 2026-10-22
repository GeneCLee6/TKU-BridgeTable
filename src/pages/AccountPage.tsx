import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { LANGS } from '../../shared/messages.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { Button, Card, ErrorText, PageMain, PageTitle } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { isAppleMobile, isStandalone, useInstallOffer } from '../lib/pwa.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { LANG_NAMES } from '../strings.ts'

/** A member's own page: display preferences and changing the password */

const Stack = styled.div`
  display: grid;
  gap: 20px;
  max-width: 560px;
`

const SectionTitle = styled.h2`
  margin: 0 0 12px;
  font-size: 18px;
  color: ${({ theme }) => theme.colors.primaryStrong};
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
    min-height: 40px;
    padding: 0 10px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.bg};
    font-size: 15px;
    font-weight: 400;
  }
`

const Choice = styled.fieldset`
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0;
  border: 0;

  & > legend { margin-bottom: 4px; font-size: 14px; font-weight: 700; }
  & label { display: flex; align-items: center; gap: 8px; font-size: 15px; }
`

const Success = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.success};
  font-weight: 600;
`

function Options<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string
  value: T
  options: [T, string][]
  onChange: (value: T) => void
}) {
  return (
    <Choice>
      <legend>{legend}</legend>
      {options.map(([key, label]) => (
        <label key={key}>
          <input type="radio" name={legend} checked={value === key} onChange={() => onChange(key)} />
          {label}
        </label>
      ))}
    </Choice>
  )
}

const Steps = styled.p`
  margin: 0 0 10px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 15px;
`

/** How to put the site on a phone's home screen: a button where the browser offers it, steps elsewhere */
function InstallApp() {
  const { t } = usePreferences()
  const { available, install } = useInstallOffer()
  if (isStandalone()) return <Success>{t.installedApp}</Success>
  const apple = isAppleMobile()
  return (
    <>
      <Steps>{t.installIntro}</Steps>
      {available && (
        <p>
          <Button type="button" $variant="primary" onClick={() => void install()}>
            {t.installButton}
          </Button>
        </p>
      )}
      {(apple || !available) && <Steps>{t.installIos}</Steps>}
      {!apple && !available && <Steps>{t.installAndroid}</Steps>}
    </>
  )
}

export function AccountPage() {
  const { t, message, lang, mode, deck, cardStyle, sound, set } = usePreferences()
  const { user } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setDone(false)
    try {
      await api.changePassword(current, next)
      setDone(true)
      setCurrent('')
      setNext('')
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
    }
  }

  return (
    <PageMain>
      <PageTitle>
        {t.accountTitle}：{user?.username}
      </PageTitle>
      <Stack>
        <Card>
          <SectionTitle>{t.preferences}</SectionTitle>
          <Options
            legend={t.languageName}
            value={lang}
            options={LANGS.map((code) => [code, LANG_NAMES[code].name])}
            onChange={(v) => set({ lang: v })}
          />
          <Options
            legend={t.cardStyle}
            value={cardStyle}
            options={[['cards', t.cardStyleCards], ['text', t.cardStyleText]]}
            onChange={(v) => set({ cardStyle: v })}
          />
          <Options legend={t.deckColors} value={deck} options={[['two', t.deckTwo], ['four', t.deckFour]]} onChange={(v) => set({ deck: v })} />
          <Options legend={t.theme} value={mode} options={[['light', t.themeLight], ['dark', t.themeDark]]} onChange={(v) => set({ mode: v })} />
          <Options
            legend={t.sound}
            value={sound ? 'on' : 'off'}
            options={[['on', t.soundOnShort], ['off', t.soundOffShort]]}
            onChange={(v) => set({ sound: v === 'on' })}
          />
        </Card>
        <Card>
          <SectionTitle>{t.installTitle}</SectionTitle>
          <InstallApp />
        </Card>
        <Card>
          <SectionTitle>{t.changePassword}</SectionTitle>
          <Form onSubmit={submit} aria-label={t.changePassword}>
            <Field>
              {t.currentPassword}
              <input type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} required />
            </Field>
            <Field>
              {t.newPassword}
              <input
                type="password"
                value={next}
                autoComplete="new-password"
                minLength={LIMITS.passwordMin}
                onChange={(e) => setNext(e.target.value)}
                required
              />
            </Field>
            {error && <ErrorText role="alert">{error}</ErrorText>}
            {done && <Success role="status">{t.saved}</Success>}
            <Button type="submit" $variant="primary">
              {t.save}
            </Button>
          </Form>
        </Card>
      </Stack>
    </PageMain>
  )
}
