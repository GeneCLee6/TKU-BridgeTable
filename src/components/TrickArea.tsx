import { useLayoutEffect, useRef } from 'react'
import styled from 'styled-components'
import type { Card, Seat } from '../../shared/cards.ts'
import type { PlayedCard } from '../../shared/game.ts'
import { CARD_RATIO } from '../lib/cards.ts'
import { prefersReducedMotion } from '../lib/motion.ts'
import { PlayingCard } from './PlayingCard.tsx'

/**
 * The cards of one trick in the middle of the table, each in front of the seat that played it.
 * A card that arrives glides in, as on BBO: from where it was on screen (the card you clicked, or
 * the hand of the player who played it) when `origin` knows, otherwise a short slide from that
 * player's side.
 */

export type Position = 'top' | 'right' | 'bottom' | 'left'

/** Where a played card was on screen just before it was played, if known */
export type CardOrigin = (card: Card, seat: Seat) => DOMRect | undefined

const GLIDE_MS = 380

const Area = styled.div<{ $w: number }>`
  position: relative;
  width: ${({ $w }) => Math.round($w * 3.1)}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO * 2.3)}px;
  margin: 0 auto;
`

const Slot = styled.div<{ $position: Position }>`
  position: absolute;
  ${({ $position }) =>
    ({
      top: 'top: 0; left: 50%; transform: translateX(-50%);',
      bottom: 'bottom: 0; left: 50%; transform: translateX(-50%);',
      left: 'left: 0; top: 50%; transform: translateY(-50%);',
      right: 'right: 0; top: 50%; transform: translateY(-50%);',
    })[$position]}
`

/** One card of the trick; it animates once, when it first appears */
function Landing({
  played,
  position,
  width,
  highlight,
  origin,
}: {
  played: PlayedCard
  position: Position
  width: number
  highlight: boolean
  origin?: CardOrigin
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Where it came from is read once: by a second run (React's strict mode) the hand has moved on
  const from = useRef<DOMRect | undefined | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof el.animate !== 'function' || prefersReducedMotion()) return
    if (from.current === null) from.current = origin?.(played.card, played.seat)
    // Measure where the card rests, not where an animation already running has it
    for (const running of el.getAnimations()) running.cancel()
    const to = el.getBoundingClientRect()
    const start = from.current
    const begin = start?.width
      ? {
          transform: `translate(${start.left + start.width / 2 - (to.left + to.width / 2)}px, ${start.top + start.height / 2 - (to.top + to.height / 2)}px)`,
          opacity: 1,
        }
      : {
          transform: {
            top: `translateY(-${width * 0.7}px)`,
            bottom: `translateY(${width * 0.7}px)`,
            left: `translateX(-${width * 0.7}px)`,
            right: `translateX(${width * 0.7}px)`,
          }[position],
          opacity: 0,
        }
    el.animate([begin, { transform: 'none', opacity: 1 }], { duration: GLIDE_MS, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' })
    // Only when the card first lands; later renders leave it where it is
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={ref}>
      <PlayingCard card={played.card} width={width} highlight={highlight} />
    </div>
  )
}

export function TrickArea({
  cards,
  positionOf,
  winner,
  width,
  label,
  origin,
}: {
  cards: PlayedCard[]
  positionOf: (seat: Seat) => Position
  winner?: Seat
  width: number
  label: string
  origin?: CardOrigin
}) {
  return (
    <Area $w={width} role="group" aria-label={label}>
      {cards.map((played) => (
        <Slot key={played.card} $position={positionOf(played.seat)}>
          <Landing played={played} position={positionOf(played.seat)} width={width} highlight={played.seat === winner} origin={origin} />
        </Slot>
      ))}
    </Area>
  )
}

/** The empty space a trick will take, so the table does not jump when the first card is played */
export const TrickSpace = styled.div<{ $w: number }>`
  width: ${({ $w }) => Math.round($w * 3.1)}px;
  height: ${({ $w }) => Math.round($w * CARD_RATIO * 2.3)}px;
`
