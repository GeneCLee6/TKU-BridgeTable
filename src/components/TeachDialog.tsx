import { useEffect, useId, useState } from 'react'
import type { PracticeSetChoice } from '../../shared/practice.ts'
import { PRACTICE_TABLE_SETTINGS, type TableAccess } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { PracticeSetPicker } from './PracticeSetPicker.tsx'
import { AccessChoices, Backdrop, Buttons, Choice, Group, Panel } from './TableSettingsDialog.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * Opens a teaching table (`e10-t10`): any deal, or deals of the teacher's choice (PBN, records they
 * may read, favourites, featured boards, the club's sets), and who may come in. Only ids go to the
 * server, which reads the deals and keeps them to itself (ARCHITECTURE.md §4)
 */
export function TeachDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  onSubmit: (set: PracticeSetChoice | undefined, access: TableAccess) => void
}) {
  const t = useT()
  const titleId = useId()
  const [chosen, setChosen] = useState(false)
  const [set, setSet] = useState<PracticeSetChoice | undefined>()
  const [access, setAccess] = useState<TableAccess>(PRACTICE_TABLE_SETTINGS.access)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <Backdrop>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.teach.dialogTitle}</h2>
        <Muted>{t.teach.intro}</Muted>
        <Group>
          <legend>{t.teach.dealsLegend}</legend>
          <Choice>
            <input
              type="radio"
              name="teach-deals"
              checked={!chosen}
              onChange={() => setChosen(false)}
            />
            {t.teach.dealsRandom}
          </Choice>
          <Choice>
            <input
              type="radio"
              name="teach-deals"
              checked={chosen}
              onChange={() => setChosen(true)}
            />
            {t.teach.dealsChosen}
          </Choice>
          {chosen && <PracticeSetPicker value={set} onChange={setSet} records />}
        </Group>
        <AccessChoices value={access} onChange={setAccess} legend={t.teach.accessLegend} />
        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button
            type="button"
            $variant="primary"
            disabled={chosen && !set}
            onClick={() => onSubmit(chosen ? set : undefined, access)}
          >
            {t.teach.open}
          </Button>
        </Buttons>
      </Panel>
    </Backdrop>
  )
}
