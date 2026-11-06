import { useCallback, useState } from 'react'
import type { Card } from '../../shared/cards.ts'
import type { TeachAnchor, TeachMarkInput } from '../../shared/teaching.ts'

export type TeachTool = 'circle' | 'arrow' | 'text'
export const TEACH_TOOLS: readonly TeachTool[] = ['circle', 'arrow', 'text']

export interface TeachMarking {
  tool: TeachTool
  setTool: (tool: TeachTool) => void
  /** An arrow's first end, once picked */
  arrowFrom: TeachAnchor | null
  /** A card or seat was picked with the tool in hand */
  target: (anchor: TeachAnchor) => void
  /** The card clicked on the table, when a tool takes cards */
  takesCards: boolean
  pickCard: (card: Card) => void
}

/** What the teacher has in hand while marking: a click on a card circles it or is an end of an arrow */
export function useTeachMarking(mark: (mark: TeachMarkInput) => void): TeachMarking {
  const [tool, setToolState] = useState<TeachTool>('circle')
  const [arrowFrom, setArrowFrom] = useState<TeachAnchor | null>(null)
  const setTool = useCallback((next: TeachTool) => {
    setToolState(next)
    setArrowFrom(null)
  }, [])
  const target = (anchor: TeachAnchor) => {
    if (tool === 'circle') {
      if ('card' in anchor) mark({ kind: 'circle', card: anchor.card })
    } else if (tool === 'arrow') {
      if (!arrowFrom) return setArrowFrom(anchor)
      setArrowFrom(null)
      if (JSON.stringify(arrowFrom) !== JSON.stringify(anchor))
        mark({ kind: 'arrow', from: arrowFrom, to: anchor })
    }
  }
  return {
    tool,
    setTool,
    arrowFrom,
    target,
    takesCards: tool !== 'text',
    pickCard: (card) => target({ card }),
  }
}
