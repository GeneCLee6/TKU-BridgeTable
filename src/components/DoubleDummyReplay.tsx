import { RotateCcw } from 'lucide-react'
import styled from 'styled-components'
import type { DdReplay } from '../lib/useDoubleDummyReplay.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Switch } from './RecordDiagram.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * The parts of double-dummy mode around a replayed board (BBO's "DD" in the movie): the switch
 * beside the replay buttons, and a line under the hands that says what the marks on the cards mean,
 * that DDS is working, or that a line is being tried out with the way back to the actual play.
 */

export function DdSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const { t } = usePreferences()
  return (
    <Switch>
      <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} />
      {t.ddMode}
    </Switch>
  )
}

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  line-height: 20px;
  text-align: center;

  & > strong { color: ${({ theme }) => theme.colors.accentStrong}; }
`

export function DdReplayBar({ dd }: { dd: DdReplay }) {
  const { t } = usePreferences()
  if (!dd.on) return null
  return (
    <Bar>
      {dd.whatIf && (
        <>
          <strong>{t.ddWhatIf}</strong>
          <Button type="button" $small onClick={dd.reset}>
            <RotateCcw size={16} aria-hidden />
            {t.ddBackToPlay}
          </Button>
        </>
      )}
      {dd.status === 'loading' && <Muted role="status">{t.ddPositionLoading}</Muted>}
      {dd.status === 'error' && <Muted role="alert">{t.ddFailed}</Muted>}
      {dd.status === 'over' && <Muted>{t.ddPlayOver}</Muted>}
      {dd.status === 'done' && <Muted>{t.ddModeHint}</Muted>}
    </Bar>
  )
}
