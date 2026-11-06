import { useLayoutEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { TeachAnchor, TeachMark } from '../../shared/teaching.ts'
import { useT } from '../state/PreferencesContext.tsx'

/**
 * What the teacher marked on a paused teaching table (`e10-t11`), drawn over the felt. It only draws
 * what the server sent this member (`visibleTeachMarks`), finding each card or seat on the page; a
 * mark on something not on the page is left out. It takes no clicks: the table stays usable under it.
 */

const Layer = styled.div`
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;

  & > svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
    stroke: ${({ theme }) => theme.colors.danger};
    stroke-width: 3;
  }
`

const Label = styled.div`
  position: absolute;
  max-width: 45%;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;
  font-weight: 600;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 2px ${({ theme }) => theme.colors.danger};
`

interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where the marks are on the felt, in its own coordinates */
interface Placed {
  key: number
  circle?: Box
  arrow?: { from: Box; to: Box }
  text?: { at: { x: number; y: number }; words: string }
}

const LABEL_STEP = 28

/**
 * The part of a card one can see: in a hand the cards after it lie over it, to the right or below,
 * so a circle round the whole card would take in its neighbours too
 */
function shownPart(card: Element, origin: DOMRect): Box {
  const own = card.getBoundingClientRect()
  let right = own.right
  let bottom = own.bottom
  const cards = [...(card.closest('[data-hand]')?.querySelectorAll('[data-card]') ?? [])]
  for (const next of cards.slice(cards.indexOf(card) + 1)) {
    const r = next.getBoundingClientRect()
    if (r.left >= right || r.right <= own.left || r.top >= bottom || r.bottom <= own.top) continue
    if (r.left > own.left + 1 && Math.abs(r.top - own.top) < 4) right = r.left
    else if (r.top > own.top + 1) bottom = r.top
  }
  return {
    x: own.left - origin.left,
    y: own.top - origin.top,
    w: right - own.left,
    h: bottom - own.top,
  }
}

function place(felt: HTMLElement, marks: readonly TeachMark[]): Placed[] {
  const origin = felt.getBoundingClientRect()
  const box = (el: Element | null): Box | null => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
  }
  const anchor = (a: TeachAnchor) => {
    if ('seat' in a) return box(felt.querySelector(`[data-hand="${a.seat}"]`))
    const card = felt.querySelector(`[data-card="${a.card}"]`)
    return card && shownPart(card, origin)
  }
  // Several notes at one place go one under the other
  const stacked = new Map<string, number>()
  return marks.flatMap((mark): Placed[] => {
    if (mark.kind === 'circle') {
      const circle = anchor({ card: mark.card })
      return circle ? [{ key: mark.id, circle }] : []
    }
    if (mark.kind === 'arrow') {
      const from = anchor(mark.from)
      const to = anchor(mark.to)
      return from && to ? [{ key: mark.id, arrow: { from, to } }] : []
    }
    const where = box(
      felt.querySelector(mark.seat ? `[data-hand="${mark.seat}"]` : '[data-center]'),
    )
    if (!where) return []
    const key = mark.seat ?? 'center'
    const n = stacked.get(key) ?? 0
    stacked.set(key, n + 1)
    return [
      {
        key: mark.id,
        text: {
          at: { x: where.x + where.w / 2, y: where.y + where.h / 2 + n * LABEL_STEP },
          words: mark.text,
        },
      },
    ]
  })
}

const middle = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** Goes right inside the felt, whose cards and seats it finds; `version` changes when they may have moved */
export function TeachOverlay({
  marks,
  version,
}: {
  marks: readonly TeachMark[]
  version: unknown
}) {
  const t = useT()
  const layer = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Placed[]>([])
  useLayoutEffect(() => {
    const el = layer.current?.parentElement
    if (!el) return
    const measure = () => setPlaced(place(el, marks))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [marks, version])
  return (
    <Layer ref={layer} role="group" aria-label={t.teach.marksLabel}>
      <svg aria-hidden>
        <defs>
          <marker
            id="teach-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0 0L10 5L0 10Z" fill="context-stroke" stroke="none" />
          </marker>
        </defs>
        {placed.map(({ key, circle, arrow }) => {
          if (circle)
            return (
              <ellipse
                key={key}
                cx={circle.x + circle.w / 2}
                cy={circle.y + circle.h / 2}
                rx={circle.w / 2 + 3}
                ry={circle.h / 2 + 3}
              />
            )
          if (!arrow) return null
          const from = middle(arrow.from)
          const to = middle(arrow.to)
          return (
            <line
              key={key}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              markerEnd="url(#teach-arrow)"
            />
          )
        })}
      </svg>
      {placed.map(({ key, text }) =>
        text ? (
          <Label key={key} style={{ left: text.at.x, top: text.at.y }}>
            {text.words}
          </Label>
        ) : null,
      )}
    </Layer>
  )
}
