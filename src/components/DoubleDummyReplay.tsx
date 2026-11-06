import { RotateCcw } from 'lucide-react'
import styled from 'styled-components'
import { rankLabel, rankOf, suitOf, type Card } from '../../shared/cards.ts'
import { cardName } from '../lib/cards.ts'
import type { DdStep } from '../lib/ddSteps.ts'
import type { DdReplay } from '../lib/useDoubleDummyReplay.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { Switch } from './RecordDiagram.tsx'
import { SuitSymbol } from './Suit.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * The parts of double-dummy mode around a replayed board (BBO's "DD" in the movie): the switch
 * beside the replay buttons, and a line under the hands that says what the marks on the cards mean,
 * that DDS is working, or that a line is being tried out with the way back to the actual play; and
 * what the last card played was worth (`e4-t35`): the best cards there and how many tricks it lost.
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

/** A card in a line of text */
export function CardName({ card }: { card: Card }) {
  const { t } = usePreferences()
  return (
    <span role="img" aria-label={cardName(card, t)}>
      <SuitSymbol suit={suitOf(card)} />
      {rankLabel(rankOf(card))}
    </span>
  )
}

const StepLine = styled.span`
  flex-basis: 100%;

  & > [data-lost] { color: ${({ theme }) => theme.colors.danger}; font-weight: 700; }
`

/** The verdict on one card: lost tricks with the best cards, or that it was best, or no number at all */
export function DdStepVerdict({ step }: { step: DdStep }) {
  const { t } = usePreferences()
  if (step.status === 'tooComplex') return <>{t.ddTooComplex}</>
  if (step.loss === 0) return <>{t.ddCardBest}</>
  return (
    <>
      <span data-lost="">{t.ddCardLost(step.loss)}</span> · {t.ddBestCard}{' '}
      {step.best.map((card, i) => (
        <span key={card}>
          {i > 0 && ' '}
          <CardName card={card} />
        </span>
      ))}
    </>
  )
}

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
      {dd.status === 'tooComplex' && <Muted role="status">{t.ddTooComplex}</Muted>}
      {dd.status === 'over' && <Muted>{t.ddPlayOver}</Muted>}
      {dd.status === 'done' && <Muted>{t.ddModeHint}</Muted>}
      {dd.lastCard && (
        <StepLine data-dd-last="">
          {seatLetter[dd.lastCard.seat]} <CardName card={dd.lastCard.card} /> <DdStepVerdict step={dd.lastCard} />
        </StepLine>
      )}
    </Bar>
  )
}
