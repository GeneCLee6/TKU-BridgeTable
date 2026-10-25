import { useEffect, useId, useRef, useState } from 'react'
import styled from 'styled-components'
import {
  BOARD_TIME_LIMITS,
  DEFAULT_TABLE_SETTINGS,
  TABLE_VISIBILITIES,
  type PublicUser,
  type TableSettings,
} from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { Button, Card, Muted } from './ui.tsx'

/**
 * How a table is run (AC-2.9, AC-2.10): asked when opening a table, and again from the host's
 * settings button. An invite table also lists the members to invite (`e2-t25`)
 */

export const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

export const Panel = styled(Card)`
  width: 100%;
  max-width: 420px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 ${({ theme }) => theme.space(3)};
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

export const Group = styled.fieldset`
  display: grid;
  gap: 8px;
  margin: 0 0 ${({ theme }) => theme.space(4)};
  padding: 0;
  border: 0;

  & > legend {
    margin-bottom: 8px;
    padding: 0;
    font-weight: 700;
  }
`

export const Choice = styled.label`
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  align-items: start;
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  cursor: pointer;

  & > input { margin: 3px 0 0; }
  & > span { font-weight: 600; }
  & > p { grid-column: 2; }
`

export const Select = styled.select`
  justify-self: start;
  min-height: 36px;
  padding: 0 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font: inherit;
`

const Invitees = styled.ul`
  display: grid;
  gap: 4px;
  max-height: 180px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;

  & label {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 2px;
    cursor: pointer;
  }
`

export const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

export function TableSettingsDialog({
  title,
  submitLabel,
  initial = DEFAULT_TABLE_SETTINGS,
  members = [],
  invited = [],
  onSubmit,
  onClose,
}: {
  title: string
  submitLabel: string
  initial?: TableSettings
  /** The members who may be invited (everyone but the host) */
  members?: PublicUser[]
  /** Who is invited already */
  invited?: string[]
  /** The settings, and the invitation list (empty unless the table is invite only) */
  onSubmit: (settings: TableSettings, invitees: string[]) => void
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  const timeId = useId()
  const [settings, setSettings] = useState(initial)
  const [invitees, setInvitees] = useState(invited)
  const first = useRef<HTMLInputElement>(null)

  // Focus once on opening; the table re-renders on every move and must not steal it back
  useEffect(() => first.current?.focus(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(settings, settings.visibility === 'invite' ? invitees : [])
          }}
        >
          <Group>
            <legend>{t.tableVisibility}</legend>
            {TABLE_VISIBILITIES.map((visibility, i) => (
              <Choice key={visibility}>
                <input
                  ref={i === 0 ? first : undefined}
                  type="radio"
                  name="visibility"
                  checked={settings.visibility === visibility}
                  onChange={() => setSettings({ ...settings, visibility })}
                />
                <span>{t.visibilities[visibility].label}</span>
                <Muted>{t.visibilities[visibility].hint}</Muted>
              </Choice>
            ))}
          </Group>
          {settings.visibility === 'invite' && (
            <Group>
              <legend>{t.invitees}</legend>
              <Muted>{t.inviteesHint}</Muted>
              {members.length ? (
                <Invitees>
                  {members.map((m) => (
                    <li key={m.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={invitees.includes(m.id)}
                          onChange={(event) =>
                            setInvitees(event.target.checked ? [...invitees, m.id] : invitees.filter((id) => id !== m.id))
                          }
                        />
                        {m.username}
                      </label>
                    </li>
                  ))}
                </Invitees>
              ) : (
                <Muted>{t.noMembersToInvite}</Muted>
              )}
            </Group>
          )}
          <Group>
            <legend>{t.kibitzers}</legend>
            <Choice>
              <input
                type="checkbox"
                checked={settings.allowKibitz}
                onChange={(event) => setSettings({ ...settings, allowKibitz: event.target.checked })}
              />
              <span>{t.allowKibitz}</span>
              <Muted>{t.allowKibitzHint}</Muted>
            </Choice>
          </Group>
          <Group>
            <legend>
              <label htmlFor={timeId}>{t.boardTime}</label>
            </legend>
            <Select
              id={timeId}
              value={settings.boardMinutes}
              onChange={(event) => setSettings({ ...settings, boardMinutes: Number(event.target.value) })}
            >
              {BOARD_TIME_LIMITS.map((m) => (
                <option key={m} value={m}>
                  {t.boardMinutesOption(m)}
                </option>
              ))}
            </Select>
            <Muted>{t.boardTimeHint}</Muted>
          </Group>
          <Buttons>
            <Button type="button" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" $variant="primary">
              {submitLabel}
            </Button>
          </Buttons>
        </form>
      </Panel>
    </Backdrop>
  )
}
