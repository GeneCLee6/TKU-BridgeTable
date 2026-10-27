import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect } from 'react'
import styled from 'styled-components'
import type { useTrickReplay } from '../lib/useTrickReplay.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { DdSwitch } from './DoubleDummyReplay.tsx'
import { PlayedCardsSwitch } from './RecordDiagram.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * BBO's movie buttons for a finished board (first, previous trick, next trick, last) and the
 * arrow keys; the record page and the side-by-side replay (`e4-t33`) share them. `dd` adds the
 * double-dummy mode switch when the board can be analysed.
 */

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
`

export function ReplayControls({
  replay,
  total,
  dd,
  keys = true,
}: {
  replay: ReturnType<typeof useTrickReplay>
  total: number
  dd?: { on: boolean; onChange: (on: boolean) => void }
  /** False leaves the arrow keys alone: the side panel's record, beside a table that plays cards with them */
  keys?: boolean
}) {
  const { t } = usePreferences()
  const { step } = replay

  useEffect(() => {
    if (!keys) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') replay.next()
      if (e.key === 'ArrowLeft') replay.prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [replay, keys])

  return (
    <Controls role="group" aria-label={t.replay}>
      <Button type="button" $small onClick={replay.start} aria-label={t.start}>
        <ChevronFirst size={18} aria-hidden />
      </Button>
      <Button type="button" $small onClick={replay.prev} disabled={replay.playing || step === 0} aria-label={t.prevTrick}>
        <ChevronLeft size={18} aria-hidden />
      </Button>
      <Muted aria-label={t.trickProgress(replay.trick, replay.tricks)}>
        {replay.trick}/{replay.tricks}
      </Muted>
      <Button type="button" $small onClick={replay.next} disabled={replay.playing || step >= total} aria-label={t.nextTrick}>
        <ChevronRight size={18} aria-hidden />
      </Button>
      <Button type="button" $small onClick={replay.end} aria-label={t.end}>
        <ChevronLast size={18} aria-hidden />
      </Button>
      <PlayedCardsSwitch />
      {dd && <DdSwitch on={dd.on} onChange={dd.onChange} />}
    </Controls>
  )
}
