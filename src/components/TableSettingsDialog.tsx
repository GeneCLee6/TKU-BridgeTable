import { useEffect, useId, useRef, useState, type Ref } from 'react'
import styled from 'styled-components'
import {
  BOARD_TIME_LIMITS,
  DEFAULT_TABLE_SETTINGS,
  TABLE_ACCESS,
  takesInvitees,
  type PublicUser,
  type TableAccess,
  type TableSettings,
} from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { Button, Card, Muted } from './ui.tsx'

/**
 * How a table is run (AC-2.9, AC-2.10): asked when opening a table, and again from the host's
 * settings button. Who may join is one of four access modes, each with a line saying what it
 * means; a request or hidden table also lists the members to invite (`e2-t25`), who come in
 * without asking. At a practice table only the access mode (who may watch) is asked
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

/** The four access modes, each with its one-line explanation (also in the practice dialog) */
export function AccessChoices({
  value,
  onChange,
  legend,
  firstRef,
}: {
  value: TableAccess
  onChange: (access: TableAccess) => void
  legend: string
  firstRef?: Ref<HTMLInputElement>
}) {
  const t = useT()
  const name = useId()
  return (
    <Group>
      <legend>{legend}</legend>
      {TABLE_ACCESS.map((access, i) => (
        <Choice key={access}>
          <input
            ref={i === 0 ? firstRef : undefined}
            type="radio"
            name={name}
            value={access}
            checked={value === access}
            onChange={() => onChange(access)}
          />
          <span>{t.accesses[access].label}</span>
          <Muted>{t.accesses[access].hint}</Muted>
        </Choice>
      ))}
    </Group>
  )
}

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
  practice = false,
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
  /** A practice table: only who may watch is asked (its seats, time and watching are fixed) */
  practice?: boolean
  /** The settings, and the invitation list (empty unless the table is a request or hidden one) */
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
            onSubmit(settings, takesInvitees(settings.access) ? invitees : [])
          }}
        >
          {practice && <Muted>{t.practiceAccessHint}</Muted>}
          <AccessChoices
            value={settings.access}
            onChange={(access) => setSettings({ ...settings, access })}
            legend={practice ? t.practiceAccess : t.tableAccess}
            firstRef={first}
          />
          {takesInvitees(settings.access) && (
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
          {!practice && (
            <>
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
            </>
          )}
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
