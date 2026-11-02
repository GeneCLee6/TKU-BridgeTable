import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TableView } from '../../shared/protocol.ts'

/**
 * Each round opens new tables (§5.22): once the club moved the player off this one, they go to the
 * table they are seated at now, or back to the event's page while their pair sits out (which takes
 * them on when their next table opens)
 */
export function usePairsFollow(tableId: string | undefined, table: TableView | null, myTableId: string | null | undefined) {
  const navigate = useNavigate()
  const event = useRef<string | null>(null)
  const current = table?.pairs && table.id === tableId ? table.pairs.id : null
  useEffect(() => {
    if (current) event.current = current
  }, [current])
  useEffect(() => {
    const id = event.current
    if (!id || myTableId === undefined || myTableId === tableId) return
    event.current = null
    if (myTableId) navigate(`/table/${myTableId}`)
    else navigate(`/pairs/${encodeURIComponent(id)}`, { state: { follow: true } })
  }, [myTableId, tableId, navigate])
}
