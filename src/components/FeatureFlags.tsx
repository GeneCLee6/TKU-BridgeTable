import { useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import { FEATURE_STATES, type FeatureState, type FeatureView } from '../../shared/features.ts'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useToast } from './Toast.tsx'
import { Button, ErrorText, Field, FieldHint, FieldLabel, Input, Muted, Select } from './ui.tsx'

/**
 * The admin page's feature flags (e11-t26, shared/features.ts): each flag's state in this club
 * (or the site-wide default) and the members who get it anyway, saved one flag at a time
 */

const List = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(6)};
`

const Flag = styled.fieldset`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  padding: 0;
  border: 0;

  & legend {
    padding: 0;
    color: ${({ theme }) => theme.colors.text};
    font-weight: 600;
  }
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: ${({ theme }) => theme.space(3)};

  & > * {
    flex: 1 1 200px;
  }
  & > button {
    flex: 0 0 auto;
  }
`

const DEFAULT = 'default'

function FlagForm({ view, onSaved }: { view: FeatureView; onSaved: (views: FeatureView[]) => void }) {
  const { t, message } = usePreferences()
  const f = t.featureFlags
  const toast = useToast()
  const { refresh } = useAuth()
  const id = useId()
  const [state, setState] = useState<FeatureState | typeof DEFAULT>(view.custom ? view.state : DEFAULT)
  const [names, setNames] = useState(view.users.map((u) => u.username).join(', '))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setError('')
    setBusy(true)
    try {
      const usernames = names.split(/[\s,，、]+/).filter(Boolean)
      const { features } = await api.admin.setFeature(view.flag, state === DEFAULT ? null : state, usernames)
      onSaved(features)
      toast.success(f.saved)
      // The admin's own flags may have changed
      await refresh()
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Flag>
      <legend>{f.names[view.flag]}</legend>
      <Muted>{f.hints[view.flag]}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Row>
        <Field>
          <FieldLabel htmlFor={`${id}-state`}>{f.title}</FieldLabel>
          <Select id={`${id}-state`} value={state} onChange={(e) => setState(e.target.value as FeatureState | typeof DEFAULT)}>
            <option value={DEFAULT}>{f.followDefault(f.states[view.default])}</option>
            {FEATURE_STATES.map((s) => (
              <option key={s} value={s}>
                {f.states[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-users`}>{f.users}</FieldLabel>
          <Input id={`${id}-users`} aria-describedby={`${id}-users-hint`} value={names} onChange={(e) => setNames(e.target.value)} autoComplete="off" />
          <FieldHint id={`${id}-users-hint`}>{f.usersHint}</FieldHint>
        </Field>
        <Button type="button" $variant="primary" $busy={busy} aria-label={`${t.save}${t.colon}${f.names[view.flag]}`} onClick={() => void save()}>
          {t.save}
        </Button>
      </Row>
    </Flag>
  )
}

export function FeatureFlags() {
  const { t, message } = usePreferences()
  const [views, setViews] = useState<FeatureView[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api.admin
      .features()
      .then(({ features }) => live && setViews(features))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError))
    return () => {
      live = false
    }
  }, [message, t])

  if (error) return <ErrorText role="alert">{error}</ErrorText>
  if (!views) return <Muted>{t.loading}</Muted>
  return (
    <List>
      {views.map((view) => (
        <FlagForm key={`${view.flag}:${view.state}:${view.custom}`} view={view} onSaved={setViews} />
      ))}
    </List>
  )
}
