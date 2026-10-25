import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api.ts'

/**
 * Which boards the member keeps (AC-4.4), read once per signed-in session and shared by every star
 * button on the page (history rows, the side panel, the result at the table, the record page), so
 * a list of boards costs one request instead of one per row. Changes show at once and are taken
 * back if the server refuses them. Signing out forgets the list (`resetFavorites`).
 */

let ids: ReadonlySet<string> | null = null
let requested = false
const listeners = new Set<() => void>()

const emit = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const snapshot = () => ids

function load() {
  if (requested) return
  requested = true
  Promise.resolve()
    .then(() => api.favoriteIds())
    .then((result) => {
      ids = new Set(result.ids)
      emit()
    })
    .catch(() => {
      // Asked again by the next button that shows
      requested = false
    })
}

function mark(boardId: string, kept: boolean) {
  const next = new Set(ids ?? [])
  if (kept) next.add(boardId)
  else next.delete(boardId)
  ids = next
  emit()
}

/** The boards the member keeps; null until they are read */
export function useFavoriteIds(): ReadonlySet<string> | null {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, snapshot)
}

/** Keeps a board or stops keeping it; the star changes at once and changes back if this throws */
export async function setFavorite(boardId: string, kept: boolean): Promise<void> {
  mark(boardId, kept)
  try {
    if (kept) await api.saveFavorite(boardId)
    else await api.removeFavorite(boardId)
  } catch (error) {
    mark(boardId, !kept)
    throw error
  }
}

/** Tells the star buttons about a change made elsewhere (the favorites page removing one) */
export const noteFavorite = mark

/** Forgets the list, on signing out (and between tests) */
export function resetFavorites() {
  ids = null
  requested = false
  emit()
}
