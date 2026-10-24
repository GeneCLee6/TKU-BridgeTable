import { useEffect, useId, useRef, useState } from 'react'
import styled from 'styled-components'
import { DEFAULT_TABLE_SETTINGS, TABLE_VISIBILITIES, type TableSettings } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { Button, Card, Muted } from './ui.tsx'

/** How a table is run (AC-2.9): asked when opening a table, and again from the host's settings button */

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
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

const Group = styled.fieldset`
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

const Choice = styled.label`
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

const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

export function TableSettingsDialog({
  title,
  submitLabel,
  initial = DEFAULT_TABLE_SETTINGS,
  onSubmit,
  onClose,
}: {
  title: string
  submitLabel: string
  initial?: TableSettings
  onSubmit: (settings: TableSettings) => void
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  const [settings, setSettings] = useState(initial)
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
            onSubmit(settings)
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
