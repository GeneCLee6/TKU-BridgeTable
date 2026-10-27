import { Volume2 } from 'lucide-react'
import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { FRIENDS_ENABLED } from '../../shared/features.ts'
import { LANGS } from '../../shared/messages.ts'
import { PROFILE_LEVELS, PROFILE_LIMITS, type Profile, type ProfileLevel } from '../../shared/profile.ts'
import { LIMITS, type Me } from '../../shared/protocol.ts'
import { Avatar } from '../components/Avatar.tsx'
import { AvatarCropper } from '../components/AvatarCropper.tsx'
import { PasswordInput } from '../components/PasswordInput.tsx'
import { useToast } from '../components/Toast.tsx'
import {
  Button,
  Card,
  CardFooter,
  CardHeader,
  CardTitle,
  ErrorText,
  Field,
  FieldError,
  FieldHint,
  FieldLabel,
  Input,
  Muted,
  PageMain,
  PageTitle,
  Select,
  Textarea,
} from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { AVATAR_INPUT_TYPES } from '../lib/avatarImage.ts'
import { isAppleMobile, isStandalone, useInstallOffer } from '../lib/pwa.ts'
import { SOUND_STYLES, SOUND_VOLUMES } from '../lib/sound/events.ts'
import { preview } from '../lib/sound/player.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { LANG_NAMES } from '../strings.ts'

/**
 * A member's own page (我的帳號): their profile (AC-1.5, e1-t16), display preferences, installing
 * the app and changing the password. Each part is a three-part card (DESIGN.md §7.3); saving says
 * so in a toast, and a field's error sits under the field (§7.2).
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(6)};
  max-width: 640px;
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Who = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};

  & a { color: ${({ theme }) => theme.colors.primary}; font-size: 14px; font-weight: 600; }
`

const AvatarButtons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
`

/**
 * 上傳頭像 (e1-t34): pick a picture, crop it in `AvatarCropper`, or go back to the default avatar.
 * Inside the profile form, so every button here is `type="button"`
 */
function AvatarControls({ user }: { user: Me }) {
  const { t, message } = usePreferences()
  const { refresh } = useAuth()
  const toast = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [removing, setRemoving] = useState(false)

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0]
    // The same file can be picked again after a cancel
    e.target.value = ''
    if (!picked) return
    if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(picked.type)) return toast.error(message('avatarBadFormat', {}, ''))
    setFile(picked)
  }

  const saved = async (_user: Me) => {
    setFile(null)
    await refresh()
    toast.success(t.avatarSaved)
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await api.removeAvatar()
      await refresh()
      toast.success(t.avatarRemoved)
    } catch (err) {
      toast.error(err instanceof ApiError && err.code ? message(err.code, err.params, err.message) : t.genericError)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
      <AvatarButtons>
        <Button type="button" $size="sm" onClick={() => input.current?.click()}>
          {user.avatar ? t.avatarChange : t.avatarUpload}
        </Button>
        {!!user.avatar && (
          <Button type="button" $size="sm" $variant="ghost" $busy={removing} disabled={removing} onClick={() => void remove()}>
            {t.avatarRemove}
          </Button>
        )}
        <input ref={input} type="file" accept={AVATAR_INPUT_TYPES.join(',')} hidden aria-label={t.avatarUpload} onChange={choose} />
      </AvatarButtons>
      <FieldHint>{t.avatarHint}</FieldHint>
      {file && <AvatarCropper file={file} onClose={() => setFile(null)} onSaved={(u) => void saved(u)} />}
    </>
  )
}

const LabelRow = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
`

const Count = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.small.size};
  font-variant-numeric: tabular-nums;
`

const Choice = styled.fieldset`
  display: grid;
  gap: 6px;
  margin: 0 0 ${({ theme }) => theme.space(4)};
  padding: 0;
  border: 0;

  &:last-child { margin-bottom: 0; }
  & > legend { margin-bottom: 4px; padding: 0; font-size: 14px; font-weight: 600; }
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

type ProfileField = 'displayName' | 'system' | 'bio'

/** Which field a server error belongs under */
const FIELD_OF: Record<string, ProfileField> = {
  profileNameTooLong: 'displayName',
  profileSystemTooLong: 'system',
  profileBioTooLong: 'bio',
}

interface Draft {
  displayName: string
  level: ProfileLevel | ''
  system: string
  bio: string
}

const draftOf = (profile: Profile | undefined): Draft => ({
  displayName: profile?.displayName ?? '',
  level: profile?.level ?? '',
  system: profile?.system ?? '',
  bio: profile?.bio ?? '',
})

const length = (text: string) => [...text].length

/** The member's own profile: what others see on the profile card (e1-t16) */
function ProfileForm() {
  const { t, message } = usePreferences()
  const { user, refresh } = useAuth()
  const toast = useToast()
  const saved = draftOf(user?.profile)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ field?: ProfileField; text: string } | null>(null)
  const id = useId()
  const value = draft ?? saved
  const changed = JSON.stringify(value) !== JSON.stringify(saved)

  const edit = (patch: Partial<Draft>) => {
    setDraft({ ...value, ...patch })
    setErrors(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErrors(null)
    try {
      await api.setProfile({ ...value, level: value.level || undefined })
      await refresh()
      setDraft(null)
      toast.success(t.profileSaved)
    } catch (err) {
      const text = err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError
      const field = err instanceof ApiError ? FIELD_OF[err.code] : undefined
      setErrors({ field, text })
    } finally {
      setBusy(false)
    }
  }

  const errorFor = (field: ProfileField) =>
    errors?.field === field ? (
      <FieldError id={`${id}-${field}-error`}>{errors.text}</FieldError>
    ) : null
  const invalid = (field: ProfileField) =>
    errors?.field === field ? { 'aria-invalid': true, 'aria-describedby': `${id}-${field}-error` } : {}

  return (
    <Card as="form" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle id={`${id}-title`}>{t.profileTitle}</CardTitle>
      </CardHeader>
      <Form as="div">
        {user && (
          <Who>
            <Avatar id={user.id} name={value.displayName || user.username} size={64} avatar={user.avatar} />
            <div>
              <Muted>{t.profileIntro}</Muted>
              <Link to={`/members/${user.id}`}>{t.fullProfile}</Link>
              <AvatarControls user={user} />
            </div>
          </Who>
        )}
        {errors && !errors.field && <ErrorText role="alert">{errors.text}</ErrorText>}
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>{t.displayName}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={value.displayName}
            maxLength={PROFILE_LIMITS.displayNameMax}
            placeholder={user?.username}
            onChange={(e) => edit({ displayName: e.target.value })}
            {...invalid('displayName')}
          />
          {errorFor('displayName') ?? <FieldHint>{t.displayNameHint(PROFILE_LIMITS.displayNameMax)}</FieldHint>}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-level`}>{t.profileLevel}</FieldLabel>
          <Select id={`${id}-level`} value={value.level} onChange={(e) => edit({ level: e.target.value as ProfileLevel | '' })}>
            <option value="">{t.levelUnset}</option>
            {PROFILE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t.levelNames[level]}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-system`}>{t.profileSystem}</FieldLabel>
          <Input
            id={`${id}-system`}
            value={value.system}
            maxLength={PROFILE_LIMITS.systemMax}
            placeholder={t.profileSystemHint}
            onChange={(e) => edit({ system: e.target.value })}
            {...invalid('system')}
          />
          {errorFor('system')}
        </Field>
        <Field>
          <LabelRow>
            <FieldLabel htmlFor={`${id}-bio`}>{t.profileBio}</FieldLabel>
            <Count aria-hidden>{t.charCount(length(value.bio), PROFILE_LIMITS.bioMax)}</Count>
          </LabelRow>
          <Textarea
            id={`${id}-bio`}
            value={value.bio}
            rows={4}
            onChange={(e) => edit({ bio: e.target.value })}
            {...(length(value.bio) > PROFILE_LIMITS.bioMax || errors?.field === 'bio'
              ? { 'aria-invalid': true, 'aria-describedby': `${id}-bio-error` }
              : {})}
          />
          {length(value.bio) > PROFILE_LIMITS.bioMax ? (
            <FieldError id={`${id}-bio-error`}>{message('profileBioTooLong', { max: PROFILE_LIMITS.bioMax }, '')}</FieldError>
          ) : (
            errorFor('bio')
          )}
        </Field>
      </Form>
      <CardFooter>
        <Button type="button" $variant="ghost" disabled={!changed || busy} onClick={() => setDraft(null)}>
          {t.revert}
        </Button>
        <Button type="submit" $variant="primary" $busy={busy} disabled={!changed || length(value.bio) > PROFILE_LIMITS.bioMax}>
          {busy ? t.saving : t.save}
        </Button>
      </CardFooter>
    </Card>
  )
}

function PasswordForm() {
  const { t, message } = usePreferences()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api.changePassword(current, next)
      setCurrent('')
      setNext('')
      toast.success(t.passwordChanged)
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card as="form" onSubmit={submit} aria-label={t.changePassword}>
      <CardHeader>
        <CardTitle>{t.changePassword}</CardTitle>
      </CardHeader>
      <Form as="div">
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Field>
          <FieldLabel htmlFor={`${id}-current`}>{t.currentPassword}</FieldLabel>
          <PasswordInput
            id={`${id}-current`}
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-next`}>{t.newPassword}</FieldLabel>
          <PasswordInput
            id={`${id}-next`}
            value={next}
            autoComplete="new-password"
            minLength={LIMITS.passwordMin}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </Field>
      </Form>
      <CardFooter>
        <Button type="submit" $variant="primary" $busy={busy}>
          {busy ? t.saving : t.save}
        </Button>
      </CardFooter>
    </Card>
  )
}

const StyleRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 12px;

  & small {
    display: block;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.small.size};
  }
  & label { align-items: flex-start; }
  & input { margin-top: 4px; }
`

const Check = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 15px;

  & input { margin-top: 4px; }
  & small {
    display: block;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.small.size};
  }
`

/**
 * Table sounds (DESIGN.md §4「音效」): on or off (the header's speaker button), a style with a
 * 試聽 button each, a volume, which kinds play, and a phone's vibration. Kept in this browser
 */
function SoundCard() {
  const { t, sound, soundStyle, soundVolume, soundBids, soundChat, soundKibitz, vibrate, set } = usePreferences()
  const s = t.sounds
  return (
    <Card>
      <CardHeader>
        <CardTitle>{s.title}</CardTitle>
      </CardHeader>
      <Muted>{s.intro}</Muted>
      <Options
        legend={s.master}
        value={sound ? 'on' : 'off'}
        options={[['on', t.soundOnShort], ['off', t.soundOffShort]]}
        onChange={(v) => set({ sound: v === 'on' })}
      />
      <Choice>
        <legend>{s.style}</legend>
        {SOUND_STYLES.map((style) => (
          <StyleRow key={style}>
            <label>
              <input type="radio" name="sound-style" checked={soundStyle === style} onChange={() => set({ soundStyle: style })} />
              <span>
                {s.styles[style]}
                <small>{s.styleHints[style]}</small>
              </span>
            </label>
            {style !== 'off' && (
              <Button type="button" $size="sm" aria-label={s.previewOf(s.styles[style])} onClick={() => preview(style, soundVolume)}>
                <Volume2 size={14} aria-hidden />
                {s.preview}
              </Button>
            )}
          </StyleRow>
        ))}
      </Choice>
      <Options
        legend={s.volume}
        value={soundVolume}
        options={SOUND_VOLUMES.map((v) => [v, s.volumes[v]])}
        onChange={(v) => set({ soundVolume: v })}
      />
      <Choice>
        <legend>{s.kinds}</legend>
        <Check>
          <input type="checkbox" checked={soundBids} onChange={(e) => set({ soundBids: e.target.checked })} />
          <span>
            {s.bids}
            <small>{s.bidsHint}</small>
          </span>
        </Check>
        <Check>
          <input type="checkbox" checked={soundChat} onChange={(e) => set({ soundChat: e.target.checked })} />
          <span>
            {s.chat}
            <small>{s.chatHint}</small>
          </span>
        </Check>
        <Check>
          <input type="checkbox" checked={soundKibitz} onChange={(e) => set({ soundKibitz: e.target.checked })} />
          <span>
            {s.kibitz}
            <small>{s.kibitzHint}</small>
          </span>
        </Check>
        <Check>
          <input type="checkbox" checked={vibrate} onChange={(e) => set({ vibrate: e.target.checked })} />
          <span>
            {s.vibrate}
            <small>{s.vibrateHint}</small>
          </span>
        </Check>
      </Choice>
    </Card>
  )
}

/** Shows the table tour again the next time a table is opened (e3-t34, AC-3.10) */
function TourCard() {
  const { t, tableTourSeen, set } = usePreferences()
  const toast = useToast()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.tourLabel}</CardTitle>
      </CardHeader>
      <Muted>{t.tourReplayHint}</Muted>
      <CardFooter>
        <Button
          type="button"
          disabled={!tableTourSeen}
          onClick={() => {
            set({ tableTourSeen: false })
            toast.success(t.tourReplayDone)
          }}
        >
          {t.tourReplay}
        </Button>
      </CardFooter>
    </Card>
  )
}

export function AccountPage() {
  const { t, lang, mode, deck, cardStyle, cardSize, confirmCalls, confirmPlays, set } = usePreferences()
  const { user, refresh } = useAuth()

  /** Kept on the server, which decides whom to tell (e1-t24) */
  const setFriendOnlineNotice = (on: boolean) =>
    void api
      .setAccountPreferences({ friendOnlineNotice: on })
      .then(refresh)
      .catch(() => undefined)

  return (
    <PageMain>
      <PageTitle>
        {t.accountTitle}：{user?.username}
      </PageTitle>
      <Stack>
        <ProfileForm />
        <Card>
          <CardHeader>
            <CardTitle>{t.preferences}</CardTitle>
          </CardHeader>
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
          <Options
            legend={t.cardSize}
            value={cardSize}
            options={[['small', t.cardSizes.small], ['medium', t.cardSizes.medium], ['large', t.cardSizes.large]]}
            onChange={(v) => set({ cardSize: v })}
          />
          <Options legend={t.deckColors} value={deck} options={[['two', t.deckTwo], ['four', t.deckFour]]} onChange={(v) => set({ deck: v })} />
          <Options legend={t.theme} value={mode} options={[['light', t.themeLight], ['dark', t.themeDark]]} onChange={(v) => set({ mode: v })} />
          <Options
            legend={t.confirmCalls}
            value={confirmCalls ? 'on' : 'off'}
            options={[['on', t.soundOnShort], ['off', t.soundOffShort]]}
            onChange={(v) => set({ confirmCalls: v === 'on' })}
          />
          <Options
            legend={t.confirmPlays}
            value={confirmPlays ? 'on' : 'off'}
            options={[['on', t.soundOnShort], ['off', t.soundOffShort]]}
            onChange={(v) => set({ confirmPlays: v === 'on' })}
          />
          {user && FRIENDS_ENABLED && (
            <Options
              legend={t.friendOnlineNotice}
              value={user.friendOnlineNotice === false ? 'off' : 'on'}
              options={[['on', t.soundOnShort], ['off', t.soundOffShort]]}
              onChange={(v) => setFriendOnlineNotice(v === 'on')}
            />
          )}
        </Card>
        <SoundCard />
        <TourCard />
        <Card>
          <CardHeader>
            <CardTitle>{t.installTitle}</CardTitle>
          </CardHeader>
          <InstallApp />
        </Card>
        <PasswordForm />
      </Stack>
    </PageMain>
  )
}
