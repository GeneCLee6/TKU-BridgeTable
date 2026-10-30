import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { useEffect } from 'react'
import styled from 'styled-components'
import type { useTrickReplay } from '../lib/useTrickReplay.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { DdSwitch } from './DoubleDummyReplay.tsx'
import { PlayedCardsSwitch } from './RecordDiagram.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * BBO's movie buttons for a finished board (first, previous trick, next trick, last) and the
 * arrow keys, one card at a time in double-dummy mode; the record page and the side-by-side replay (`e4-t33`) share them. `dd` adds the
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

const Label = styled.label`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  color: ${({ theme }) => theme.colors.textMuted};
`

/** m:ss */
const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ReplayControls({
  replay,
  total,
  dd,
  real,
  keys = true,
}: {
  replay: ReturnType<typeof useTrickReplay>
  total: number
  dd?: { on: boolean; onChange: (on: boolean) => void }
  /**
   * 照實際速度 (`e2-t33`), when the record has its action log: the switch, and how long into the
   * board the card shown was played (ms); with it on, a play button runs the rest of the board
   */
  real?: { on: boolean; onChange: (on: boolean) => void; elapsed: number }
  /** False leaves the arrow keys alone: the side panel's record, beside a table that plays cards with them */
  keys?: boolean
}) {
  const { t } = usePreferences()
  const { step } = replay
  // In double-dummy mode the buttons and arrow keys move one card at a time (BBO), so after every
  // card the hand to play next shows what each of its cards is worth
  const byCard = !!dd?.on
  const next = byCard ? replay.nextCard : replay.next
  const prev = byCard ? replay.prevCard : replay.prev

  useEffect(() => {
    if (!keys) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') next()
      if (e.key === 'ArrowLeft') prev()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, keys])

  return (
    <Controls role="group" aria-label={t.replay}>
      <Button type="button" $small onClick={replay.start} aria-label={t.start}>
        <ChevronFirst size={18} aria-hidden />
      </Button>
      <Button type="button" $small onClick={prev} disabled={replay.playing || step === 0} aria-label={byCard ? t.prevCard : t.prevTrick}>
        <ChevronLeft size={18} aria-hidden />
      </Button>
      <Muted aria-label={t.trickProgress(replay.trick, replay.tricks)}>
        {replay.trick}/{replay.tricks}
      </Muted>
      <Button type="button" $small onClick={next} disabled={replay.playing || step >= total} aria-label={byCard ? t.nextCard : t.nextTrick}>
        <ChevronRight size={18} aria-hidden />
      </Button>
      <Button type="button" $small onClick={replay.end} aria-label={t.end}>
        <ChevronLast size={18} aria-hidden />
      </Button>
      {real?.on && (
        <Button
          type="button"
          $small
          onClick={replay.playing ? replay.pause : replay.play}
          disabled={!replay.playing && step >= total}
          aria-label={replay.playing ? t.realReplay.pause : t.realReplay.play}
        >
          {replay.playing ? <Pause size={18} aria-hidden /> : <Play size={18} aria-hidden />}
        </Button>
      )}
      {real?.on && step > 0 && <Muted>{t.realReplay.elapsed(clock(real.elapsed))}</Muted>}
      {real && (
        <Label>
          <input type="checkbox" checked={real.on} onChange={(e) => real.onChange(e.target.checked)} />
          {t.realReplay.realSpeed}
        </Label>
      )}
      <PlayedCardsSwitch />
      {dd && <DdSwitch on={dd.on} onChange={dd.onChange} />}
    </Controls>
  )
}
