import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styled from 'styled-components'
import { useT } from '../state/PreferencesContext.tsx'
import { Button } from './ui.tsx'

/**
 * The first-visit table tour (e3-t34, AC-3.10): five steps (bidding box, Alert, claim, undo, the
 * side panel), each lighting up its part of the page under a dimmed mask, with back, next and
 * skip. A step's part is found by `data-tour`; when it is not on screen (no board yet, a phone
 * that hides it) the next name in its list is tried, and failing all the step is shown without a
 * light. Esc skips; the page behind cannot be used until the tour is closed.
 */

export type TourStepId = 'bidding' | 'alert' | 'claim' | 'undo' | 'side'

/** Each step and the parts of the page it may light up, best first */
export const TABLE_TOUR: { id: TourStepId; targets: string[] }[] = [
  { id: 'bidding', targets: ['bidding-box', 'center'] },
  { id: 'alert', targets: ['alert', 'bidding-box', 'center'] },
  { id: 'claim', targets: ['claim', 'actions'] },
  { id: 'undo', targets: ['undo', 'actions'] },
  { id: 'side', targets: ['side'] },
]

const PAD = 6

const Mask = styled.div<{ $dim: boolean }>`
  position: fixed;
  inset: 0;
  z-index: 50;
  background: ${({ theme, $dim }) => ($dim ? theme.colors.overlay : 'transparent')};
`

/** The lit part: a hole in the mask (its shadow is the mask) with an accent outline */
const Light = styled.div`
  position: fixed;
  z-index: 51;
  border-radius: ${({ theme }) => theme.radius.md};
  box-shadow: 0 0 0 9999px ${({ theme }) => theme.colors.overlay};
  outline: 3px solid ${({ theme }) => theme.colors.accent};
  pointer-events: none;
  transition: top 0.2s, left 0.2s, width 0.2s, height 0.2s;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`

const Dialog = styled.div<{ $at: 'top' | 'bottom' | 'middle' }>`
  position: fixed;
  z-index: 52;
  left: 50%;
  ${({ $at }) => ($at === 'top' ? 'top: 16px;' : $at === 'bottom' ? 'bottom: 16px;' : 'top: 50%;')}
  transform: translate(-50%, ${({ $at }) => ($at === 'middle' ? '-50%' : '0')});
  width: min(380px, calc(100vw - 32px));
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  padding: ${({ theme }) => theme.space(5)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadowRaised};
`

const Step = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: ${({ theme }) => theme.type.caption.size};
  font-weight: ${({ theme }) => theme.type.caption.weight};
`

const Title = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.type.h2.size};
  line-height: ${({ theme }) => theme.type.h2.line};
`

const Text = styled.p`
  margin: 0;
  font-size: ${({ theme }) => theme.type.body.size};
  line-height: ${({ theme }) => theme.type.body.line};
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)};
  justify-content: flex-end;

  & > :first-child {
    margin-right: auto;
  }
`

function findTarget(names: string[]): DOMRect | null {
  for (const name of names) {
    const el = document.querySelector(`[data-tour="${name}"]`)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return rect
  }
  return null
}

export function TableTour({ onClose }: { onClose: () => void }) {
  const t = useT()
  const id = useId()
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const next = useRef<HTMLButtonElement>(null)
  const step = TABLE_TOUR[index]
  const last = index === TABLE_TOUR.length - 1

  // Where the step's part is now, and again whenever the window changes
  useLayoutEffect(() => {
    const measure = () => setRect(findTarget(step.targets))
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [step])

  useEffect(() => {
    next.current?.focus()
  }, [index])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The dialog goes in the half of the window the lit part is not in
  const at = !rect ? 'middle' : rect.top + rect.height / 2 < window.innerHeight / 2 ? 'bottom' : 'top'
  const text = t.tourSteps[step.id]

  return createPortal(
    <>
      <Mask $dim={!rect} onClick={(event) => event.stopPropagation()} data-testid="tour-mask" />
      {rect && (
        <Light
          data-testid="tour-light"
          style={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }}
        />
      )}
      <Dialog $at={at} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}>
        <Step>
          {t.tourLabel} · {t.tourStepOf(index + 1, TABLE_TOUR.length)}
        </Step>
        <Title id={`${id}-title`}>{text.title}</Title>
        <Text id={`${id}-text`}>{text.text}</Text>
        <Buttons>
          <Button type="button" $variant="ghost" $size="sm" onClick={onClose}>
            {t.tourSkip}
          </Button>
          {index > 0 && (
            <Button type="button" $size="sm" onClick={() => setIndex(index - 1)}>
              {t.tourBack}
            </Button>
          )}
          <Button ref={next} type="button" $variant="primary" $size="sm" onClick={() => (last ? onClose() : setIndex(index + 1))}>
            {last ? t.tourDone : t.tourNext}
          </Button>
        </Buttons>
      </Dialog>
    </>,
    document.body,
  )
}
