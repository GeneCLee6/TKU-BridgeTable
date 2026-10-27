import { useLayoutEffect, useRef } from 'react'
import styled from 'styled-components'
import type { Card, Seat } from '../../shared/cards.ts'
import type { PlayedCard } from '../../shared/game.ts'
import { trickBox } from '../lib/cards.ts'
import { PACE, prefersReducedMotion, type Pace } from '../lib/motion.ts'
import { PlayingCard } from './PlayingCard.tsx'

/**
 * The cards of one trick in the middle of the table, each in front of the seat that played it.
 * A card that arrives glides in, as on BBO: from where it was on screen (the card you clicked, or
 * the hand of the player who played it) when `origin` knows, otherwise a short slide from that
 * player's side. A finished trick that is `leaving` is taken by its winner: the four cards gather
 * on the winning card and slide off towards that player, at the same unhurried pace.
 */

export type Position = 'top' | 'right' | 'bottom' | 'left'

/** Where a played card was on screen just before it was played, if known */
export type CardOrigin = (card: Card, seat: Seat) => DOMRect | undefined

/** How long the glides take (`paceOf`): a card to the middle, easing in gently and settling softly, and a finished trick to its winner */
type Glides = Pick<Pace, 'glideMs' | 'collectMs'>
const GLIDE_EASING = 'cubic-bezier(0.33, 0.1, 0.2, 1)'

const Area = styled.div<{ $w: number; $tall: boolean }>`
  position: relative;
  width: ${({ $w, $tall }) => trickBox($w, $tall).width}px;
  height: ${({ $w, $tall }) => trickBox($w, $tall).height}px;
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
  glideMs,
}: {
  played: PlayedCard
  position: Position
  width: number
  highlight: boolean
  origin?: CardOrigin
  glideMs: number
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
    el.animate([begin, { transform: 'none', opacity: 1 }], { duration: glideMs, easing: GLIDE_EASING })
    // Only when the card first lands; later renders leave it where it is
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={ref}>
      <PlayingCard card={played.card} width={width} highlight={highlight} />
    </div>
  )
}

/** Which way each seat's cards leave the middle when that seat takes the trick */
const AWAY: Record<Position, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] }

/** A finished trick going to its winner: the cards gather on the winning card, then slide off together */
function Leaving({
  trick,
  positionOf,
  width,
  collectMs,
}: {
  trick: { cards: PlayedCard[]; winner: Seat }
  positionOf: (seat: Seat) => Position
  width: number
  collectMs: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const layer = ref.current
    if (!layer || prefersReducedMotion()) return
    const items = [...layer.querySelectorAll<HTMLElement>('[data-leaving]')]
    const target = items.find((el) => el.dataset.leaving === trick.winner)
    if (!target || typeof target.animate !== 'function') return
    for (const el of items) for (const running of el.getAnimations()) running.cancel()
    const to = target.getBoundingClientRect()
    const [ax, ay] = AWAY[positionOf(trick.winner)]
    const away = width * 1.4
    for (const el of items) {
      const from = el.getBoundingClientRect()
      const dx = to.left - from.left
      const dy = to.top - from.top
      el.animate(
        [
          { transform: 'none', opacity: 1 },
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${dx + ax * away}px, ${dy + ay * away}px) scale(0.7)`, opacity: 0 },
        ],
        { duration: collectMs, easing: GLIDE_EASING, fill: 'forwards' },
      )
    }
    // Only when the trick starts to leave
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div ref={ref} aria-hidden>
      {trick.cards.map((played) => (
        <Slot key={played.card} $position={positionOf(played.seat)} style={played.seat === trick.winner ? { zIndex: 1 } : undefined}>
          <div data-leaving={played.seat}>
            <PlayingCard card={played.card} width={width} highlight={played.seat === trick.winner} />
          </div>
        </Slot>
      ))}
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
  leaving,
  pace = PACE,
  tall = false,
}: {
  cards: PlayedCard[]
  positionOf: (seat: Seat) => Position
  winner?: Seat
  width: number
  label: string
  origin?: CardOrigin
  /** The trick before, on its way to the player who won it */
  leaving?: { cards: PlayedCard[]; winner: Seat; key: string }
  /** How long the glides take: the table's robot speed (`paceOf`), the default speed's elsewhere */
  pace?: Glides
  /** The narrow, tall box (`trickBox`) */
  tall?: boolean
}) {
  return (
    <Area $w={width} $tall={tall} role="group" aria-label={label}>
      {leaving && <Leaving key={leaving.key} trick={leaving} positionOf={positionOf} width={width} collectMs={pace.collectMs} />}
      {cards.map((played) => (
        <Slot key={played.card} $position={positionOf(played.seat)} style={leaving ? { zIndex: 2 } : undefined}>
          <Landing played={played} position={positionOf(played.seat)} width={width} highlight={played.seat === winner} origin={origin} glideMs={pace.glideMs} />
        </Slot>
      ))}
    </Area>
  )
}

/** The empty space a trick will take, so the table does not jump when the first card is played */
export const TrickSpace = styled.div<{ $w: number; $tall?: boolean }>`
  width: ${({ $w, $tall }) => trickBox($w, $tall).width}px;
  height: ${({ $w, $tall }) => trickBox($w, $tall).height}px;
`
