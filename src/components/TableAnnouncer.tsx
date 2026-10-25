import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView } from '../../shared/protocol.ts'
import { announcements } from '../lib/announce.ts'
import { useT } from '../state/PreferencesContext.tsx'

/** Read by screen readers, not drawn */
export const VisuallyHidden = styled.div`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`

/** How many sentences stay in the log (older ones have been read already) */
const KEEP = 12

/**
 * The table's live region (e3-t33): every call, card, trick, contract, result and turn is added
 * to a polite log, so a screen reader follows the board without looking (`lib/announce.ts`).
 */
export function TableAnnouncer({ board, me, who }: { board: BoardView | null; me: Seat | null; who: (seat: Seat) => string }) {
  const t = useT()
  const last = useRef<BoardView | null>(null)
  const [log, setLog] = useState<{ id: number; text: string }[]>([])
  const nextId = useRef(0)

  useEffect(() => {
    const before = last.current
    last.current = board
    if (before === board) return
    const said = announcements(before, board, { t, me, who })
    if (said.length === 0) return
    setLog((old) => [...old, ...said.map((text) => ({ id: nextId.current++, text }))].slice(-KEEP))
    // `who` is a new function on every render; only a new board view is news
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [board, me, t])

  return (
    <VisuallyHidden role="log" aria-live="polite" aria-label={t.srLog} data-testid="table-announcer">
      {log.map((entry) => (
        <p key={entry.id}>{entry.text}</p>
      ))}
    </VisuallyHidden>
  )
}
