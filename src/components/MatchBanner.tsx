import { Trophy } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { TableMatch } from '../../shared/protocol.ts'
import { useMatchScoreSound } from '../lib/sound/hooks.ts'
import { useTeamMatch } from '../lib/useTeamMatch.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { ScoreLine } from './MatchParts.tsx'

/**
 * The title of a team match table (`e8-t10`): the room and which board of how many, and the
 * match's score above the table. The score is the match's own (`useTeamMatch`, pushed live), so it
 * only counts boards both rooms played: nothing here tells the players how the other room did on
 * a board they have still to play. A room that played every board waits for the other (`e8-t08`);
 * while the host has the match paused it says so (`e8-t16`)
 */

const Wrap = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;

  & small {
    font-weight: 400;
    opacity: 0.9;
  }
  & a {
    color: inherit;
  }
`

export function MatchBanner({ match, watching = false }: { match: TableMatch; watching?: boolean }) {
  const t = useT()
  const { match: view } = useTeamMatch(match.id)
  // People watching hear the other room's result come in; the players do not (DESIGN.md §4)
  useMatchScoreSound(view, watching)
  // Before the first deal the next board is the one after those played
  const seq = match.seq || Math.min(match.played + 1, match.boards)
  const playing = !view || view.status === 'playing'
  return (
    <Wrap>
      <Trophy size={15} aria-hidden />
      {/* A new tab: leaving this page would leave a watcher's seat at the table */}
      <Link to={`/matches/${encodeURIComponent(match.id)}`} target="_blank" rel="noopener">
        {t.teamMatch.roomBoard(t.teamMatch.rooms[match.room], seq, match.boards)}
      </Link>
      {view && (
        <small>
          <ScoreLine match={view} />
        </small>
      )}
      {match.paused ? (
        <small role="status">{t.teamMatch.pausedHint}</small>
      ) : (
        match.over && playing && <small role="status">{t.teamMatch.waitingOther}</small>
      )}
    </Wrap>
  )
}
