import { useLayoutEffect, useRef, type RefObject } from 'react'
import styled from 'styled-components'
import { CARD_RATIO } from '../lib/cards.ts'
import { PACE, prefersReducedMotion } from '../lib/motion.ts'
import type { Position } from './TrickArea.tsx'

/**
 * The deal, as an animation: four packets of cards leave the middle of the table together and
 * slide out to the four hands, which then appear (the table fades them in after DEAL_MS). The
 * felt marks the middle with `data-center` and each hand with `data-hand-at="top"` and so on.
 */

export const DEAL_MS = PACE.dealMs

const POSITIONS: Position[] = ['top', 'right', 'bottom', 'left']

const Layer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 8;
  overflow: hidden;
  pointer-events: none;
`

const Packet = styled.div<{ $w: number }>`
  position: absolute;
  top: 0;
  left: 0;
  width: ${({ $w }) => $w}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO)}px;

  /* A few backs, offset a little, so it reads as a stack of cards */
  & > span {
    position: absolute;
    inset: 0;
    border: 2px solid ${({ theme }) => theme.table.cardFace};
    border-radius: 5px;
    background: repeating-linear-gradient(
      45deg,
      ${({ theme }) => theme.table.cardBack} 0 5px,
      ${({ theme }) => theme.table.cardBackStripe} 5px 10px
    );
    box-shadow: ${({ theme }) => theme.cardShadow};
  }
  & > span:nth-child(2) { transform: translate(2px, -2px); }
  & > span:nth-child(3) { transform: translate(4px, -4px); }
`

export function DealAnimation({ felt: feltRef, width }: { felt: RefObject<HTMLElement | null>; width: number }) {
  const layer = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const root = layer.current
    const felt = feltRef.current
    if (!root || !felt || prefersReducedMotion()) return
    const box = root.getBoundingClientRect()
    const middle = felt.querySelector('[data-center]')?.getBoundingClientRect() ?? box
    const packets = [...root.children] as HTMLElement[]
    packets.forEach((el, i) => {
      if (typeof el.animate !== 'function') return
      const hand = felt.querySelector(`[data-hand-at="${POSITIONS[i]}"]`)?.getBoundingClientRect()
      const half = { x: el.offsetWidth / 2, y: el.offsetHeight / 2 }
      const from = { x: middle.left + middle.width / 2 - box.left - half.x, y: middle.top + middle.height / 2 - box.top - half.y }
      const to = hand ? { x: hand.left + hand.width / 2 - box.left - half.x, y: hand.top + hand.height / 2 - box.top - half.y } : from
      el.animate(
        [
          { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 1 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(0.92)`, opacity: 1, offset: 0.82 },
          { transform: `translate(${to.x}px, ${to.y}px) scale(0.92)`, opacity: 0 },
        ],
        { duration: DEAL_MS, easing: 'cubic-bezier(0.25, 0.7, 0.3, 1)', fill: 'both' },
      )
    })
  }, [feltRef])

  return (
    <Layer ref={layer} aria-hidden>
      {POSITIONS.map((position) => (
        <Packet key={position} $w={width}>
          <span />
          <span />
          <span />
        </Packet>
      ))}
    </Layer>
  )
}
