import { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'
import { PUSH_GROUP_NAMES, PUSH_GROUPS, type PushGroup, type PushKinds, type PushView } from '../../shared/push.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { forgetThisClub, pushSupport, subscribeThisDevice, thisDeviceId, unsubscribeThisDevice, type PushSupport } from '../lib/push.ts'
import { useAuth, useFeature } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardFooter, CardHeader, CardTitle, ErrorText, Muted } from './ui.tsx'

/**
 * "My account"'s push notifications (PWA 推播, e1-t28): turning them on or off on this device, the
 * devices that get them (removing one), a test push, and which kinds are pushed, in groups (a box
 * switches every kind of its group; the server keeps the choice per kind). Shown only when the
 * club has push (the VAPID secrets, DEPLOY.md §4.17). iPhones and iPads get pushes only from the
 * site added to the home screen, which the card explains instead
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Status = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
`

const List = styled.ul`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
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

const Heading = styled.h3`
  margin: 0;
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.body.size};
  font-weight: 600;
`

const Kinds = styled.fieldset`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin: 0;
  padding: 0;
  border: 0;

  & > legend {
    margin-bottom: ${({ theme }) => theme.space(2)};
    padding: 0;
    color: ${({ theme }) => theme.colors.text};
    font-weight: 600;
  }
  & label {
    display: flex;
    align-items: flex-start;
    gap: ${({ theme }) => theme.space(2)};
    color: ${({ theme }) => theme.colors.text};
  }
  & input {
    margin-top: 4px;
  }
`

/** A group is on when any of its kinds is (a member's older per-kind choice may leave it mixed) */
const groupOn = (kinds: PushKinds, group: PushGroup) => PUSH_GROUPS[group].some((kind) => kinds[kind])

export function PushCard() {
  const { t, lang, message } = usePreferences()
  const p = t.push
  const toast = useToast()
  const { user } = useAuth()
  const friendsOn = useFeature('friends')
  const tournamentsOn = useFeature('tournaments')
  const [view, setView] = useState<PushView | null>(null)
  const [support] = useState<PushSupport>(pushSupport)
  const [mine, setMine] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const text = useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t])

  useEffect(() => {
    let live = true
    api.push
      .view()
      .then((v) => live && setView(v))
      .catch(() => live && setView(null))
    void thisDeviceId().then((id) => live && setMine(id))
    return () => {
      live = false
    }
  }, [])

  if (!view?.enabled || !user) return null

  const subscribed = !!mine && view.devices.some((d) => d.id === mine)

  const act = async (run: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try {
      await run()
    } catch (e) {
      setError(text(e))
    } finally {
      setBusy(false)
    }
  }

  const enable = () =>
    act(async () => {
      if (!view.publicKey) return
      if (!(await subscribeThisDevice(view.publicKey, lang))) {
        setError(p.denied)
        return
      }
      setMine(await thisDeviceId())
      setView(await api.push.view())
      toast.success(p.enabled)
    })

  const disable = () =>
    act(async () => {
      await unsubscribeThisDevice()
      setMine(null)
      setView(await api.push.view())
      toast.success(p.disabled)
    })

  const remove = (id: string) =>
    act(async () => {
      setView(await api.push.unsubscribe(id))
      // This browser, removed from the list: this club no longer uses its subscription (other clubs may)
      if (id === mine) forgetThisClub()
      toast.success(p.removed)
    })

  const test = () =>
    act(async () => {
      const { devices } = await api.push.test()
      toast.success(p.testSent(devices))
    })

  const choose = (group: PushGroup, on: boolean) =>
    act(async () => {
      const kinds = Object.fromEntries(PUSH_GROUPS[group].map((kind) => [kind, on]))
      setView(await api.push.kinds(kinds))
      toast.success(p.saved)
    })

  const groups = PUSH_GROUP_NAMES.filter((g) => (g === 'admin' ? user.admin : g === 'friends' ? friendsOn : g === 'tournaments' ? tournamentsOn || user.admin : true))
  const hint = support === 'homeScreen' ? p.iosHint : support === 'unsupported' ? p.unsupported : support === 'denied' ? p.denied : ''

  return (
    <Card aria-label={p.title}>
      <CardHeader>
        <CardTitle>{p.title}</CardTitle>
      </CardHeader>
      <Stack>
        <Muted>{p.intro}</Muted>
        {hint ? <Muted role="note">{hint}</Muted> : <Status role="status">{subscribed ? p.thisOn : p.thisOff}</Status>}
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <section aria-label={p.devices}>
          <Stack>
            <Heading>{p.devices}</Heading>
            {view.devices.length ? (
              <List>
                {view.devices.map((device) => {
                  const name = device.name || p.unknownDevice
                  return (
                    <Row key={device.id}>
                      <span>
                        <strong>
                          {name}
                          {device.id === mine && <Tag>{p.thisDevice}</Tag>}
                        </strong>
                        <small>{p.since(formatDate(device.createdAt, lang))}</small>
                      </span>
                      <Button type="button" $size="sm" disabled={busy} aria-label={p.removeLabel(name)} onClick={() => void remove(device.id)}>
                        {p.remove}
                      </Button>
                    </Row>
                  )
                })}
              </List>
            ) : (
              <Muted>{p.noDevices}</Muted>
            )}
          </Stack>
        </section>
        <Kinds disabled={busy}>
          <legend>{p.kinds}</legend>
          <Muted>{p.kindsHint}</Muted>
          {groups.map((group) => (
            <label key={group}>
              <input type="checkbox" checked={groupOn(view.kinds, group)} onChange={(e) => void choose(group, e.target.checked)} />
              <span>{p.groups[group]}</span>
            </label>
          ))}
        </Kinds>
      </Stack>
      <CardFooter>
        {!hint &&
          (subscribed ? (
            <Button type="button" disabled={busy} onClick={() => void disable()}>
              {p.disable}
            </Button>
          ) : (
            <Button type="button" $variant="primary" $busy={busy} onClick={() => void enable()}>
              {p.enable}
            </Button>
          ))}
        <Button type="button" disabled={busy || !view.devices.length} onClick={() => void test()}>
          {p.test}
        </Button>
      </CardFooter>
    </Card>
  )
}
