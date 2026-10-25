import { useCallback, useEffect, useRef, useState } from 'react'
import type { TeamMatchView } from '../../shared/team-match.ts'
import { useClub } from '../state/ClubContext.tsx'
import { ApiError, api } from './api.ts'

/**
 * A team match as the member may see it (§5.8), kept live: loaded once, then replaced by every
 * change the server pushes (`match`, to everyone in the match and at its tables). `undefined`
 * while loading, `null` when it is not there for them. The prep room (`MatchPage`) and the score
 * over a match table (`MatchBanner`) both use it
 */
export function useTeamMatch(matchId: string | undefined) {
  const { matchLive } = useClub()
  /** What is known, and for which match: a page that turns to another match starts again */
  const [known, setKnown] = useState<{ id: string; match: TeamMatchView | null } | null>(null)
  const [error, setError] = useState<{ id: string; error: unknown } | null>(null)

  useEffect(() => {
    if (!matchId) return
    let live = true
    api
      .match(matchId)
      .then((r) => live && setKnown({ id: matchId, match: r.match }))
      .catch((e) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 404) setKnown({ id: matchId, match: null })
        else setError({ id: matchId, error: e })
      })
    return () => {
      live = false
    }
  }, [matchId])

  // Pushed changes; the one held when the page opened may be older than what the page loads
  const first = useRef(matchLive)
  useEffect(() => {
    if (!matchLive || matchLive === first.current || matchLive.matchId !== matchId) return
    setKnown({ id: matchLive.matchId, match: matchLive.match })
  }, [matchLive, matchId])

  const setMatch = useCallback((match: TeamMatchView | null) => {
    if (matchId) setKnown({ id: matchId, match })
  }, [matchId])

  return {
    match: known && known.id === matchId ? known.match : undefined,
    setMatch,
    error: error && error.id === matchId ? error.error : null,
  }
}
