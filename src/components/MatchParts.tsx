import { Columns2 } from 'lucide-react'
import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { rankLabel, rankOf, suitOf } from '../../shared/cards.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { ROOMS, type MatchRoomView, type TeamMatchView } from '../../shared/team-match.ts'
import { cardName } from '../lib/cards.ts'
import { points, teamName } from '../lib/matches.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ContractLabel, SuitSymbol } from './Suit.tsx'
import { Button } from './ui.tsx'

/** Pieces the team match pages share (§5.8) */

/** A small label: the match's state (open ones stand out), or 「邀請你」 in the accent colour */
export const Tag = styled.span<{ $open: boolean; $accent?: boolean }>`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentSoft : $open ? theme.colors.primarySoft : theme.colors.surfaceAlt};
  color: ${({ theme, $open, $accent }) =>
    $accent ? theme.colors.accentStrong : $open ? theme.colors.primaryStrong : theme.colors.textMuted};
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

const Score = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  font-variant-numeric: tabular-nums;

  & > strong {
    font-size: 1.15em;
  }
`

/**
 * The match score (AC-8.5): both teams' names and totals, counting only boards both rooms played
 * (or the host ruled on), how many those are, and once it ended who won
 */
export function ScoreLine({ match }: { match: TeamMatchView }) {
  const { t } = usePreferences()
  const a = teamName(t, match, 'A')
  const b = teamName(t, match, 'B')
  const ended = match.status === 'finished' || match.status === 'abandoned'
  return (
    <Score role="group" aria-label={t.teamMatch.score}>
      <span>{a}</span>
      <strong>
        {points(match.totals.A)} : {points(match.totals.B)}
      </strong>
      <span>{b}</span>
      <small>
        {ended
          ? match.leader
            ? t.teamMatch.winner(match.leader === 'A' ? a : b)
            : t.teamMatch.tie
          : t.teamMatch.boardsDone(match.boards.length, match.settings.boards)}
      </small>
    </Score>
  )
}

const Scroll = styled.div`
  overflow-x: auto;
`

const Grid = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;

  & th,
  & td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: right;
  }
  & th:first-child,
  & td:first-child {
    text-align: left;
  }
  & thead th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
  }
  & thead th[scope='colgroup'] {
    text-align: center;
  }
  & td.text {
    text-align: left;
  }
  & a {
    color: ${({ theme }) => theme.colors.primary};
  }
`

const Note = styled.td`
  color: ${({ theme }) => theme.colors.accentStrong};
  white-space: normal;
  text-align: left !important;
`

/** One room's contract, opening lead, result and North-South score (linked to its record) */
function RoomCells({ room }: { room?: MatchRoomView }) {
  const { t } = usePreferences()
  if (!room)
    return (
      <>
        <td className="text">—</td>
        <td className="text">—</td>
        <td className="text">—</td>
        <td>—</td>
      </>
    )
  const contract = room.contract
  return (
    <>
      <td className="text">{contract === undefined ? '—' : <ContractLabel contract={contract} />}</td>
      <td className="text" aria-label={room.lead ? cardName(room.lead, t) : undefined}>
        {room.lead ? (
          <>
            <SuitSymbol suit={suitOf(room.lead)} />
            {rankLabel(rankOf(room.lead))}
          </>
        ) : (
          '—'
        )}
      </td>
      <td className="text">{contract && room.declarerTricks != null ? resultLabel(contract, room.declarerTricks) : '—'}</td>
      <td>
        <Link to={`/history/${encodeURIComponent(room.boardId)}`}>{room.scoreNS}</Link>
      </td>
    </>
  )
}

/**
 * The result page's board by board (`e8-t12`, AC-8.7): each room's contract (with the declarer),
 * opening lead, result and North-South score, what each team won, the running score, and a
 * side-by-side replay of the two rooms (`/history/:open/vs/:closed`, C7). A board the host ruled on
 * says so, with the reason. Only boards both rooms played (or the host ruled on) are in the match
 * view at all
 */
export function BoardScores({ match }: { match: TeamMatchView }) {
  const { t } = usePreferences()
  const a = teamName(t, match, 'A')
  const b = teamName(t, match, 'B')
  // The running score after each board
  const running = match.boards.map((_, i) =>
    match.boards.slice(0, i + 1).reduce((sum, board) => ({ A: sum.A + board.result.A, B: sum.B + board.result.B }), { A: 0, B: 0 }),
  )
  return (
    <Scroll>
      <Grid>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>
              {t.teamMatch.boardColumn}
            </th>
            {ROOMS.map((room) => (
              <th key={room} scope="colgroup" colSpan={4}>
                {t.teamMatch.rooms[room]}
              </th>
            ))}
            <th scope="col" rowSpan={2}>
              {a}
            </th>
            <th scope="col" rowSpan={2}>
              {b}
            </th>
            <th scope="col" rowSpan={2}>
              {t.teamMatch.running}
            </th>
            <th scope="col" rowSpan={2} aria-label={t.teamMatch.replay} />
          </tr>
          <tr>
            {ROOMS.map((room) => (
              <Fragment key={room}>
                <th scope="col">{t.contract}</th>
                <th scope="col">{t.openingLead}</th>
                <th scope="col">{t.result}</th>
                <th scope="col">{t.teamMatch.roomScore(t.teamMatch.rooms[room])}</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {match.boards.map((board, i) => {
            const ruling = board.ruling
            return (
              <Fragment key={board.seq}>
                <tr>
                  <th scope="row">
                    {board.seq}
                    {ruling && ` · ${t.teamMatch.ruled}`}
                  </th>
                  <RoomCells room={board.open} />
                  <RoomCells room={board.closed} />
                  <td>{points(board.result.A)}</td>
                  <td>{points(board.result.B)}</td>
                  <td>
                    {points(running[i].A)} : {points(running[i].B)}
                  </td>
                  <td>
                    {board.open && board.closed && (
                      <Button
                        as={Link}
                        to={`/history/${encodeURIComponent(board.open.boardId)}/vs/${encodeURIComponent(board.closed.boardId)}`}
                        $small
                        $variant="ghost"
                        aria-label={`${t.teamMatch.replay} ${board.seq}`}
                      >
                        <Columns2 size={16} aria-hidden />
                      </Button>
                    )}
                  </td>
                </tr>
                {ruling && (
                  <tr>
                    <td />
                    <Note colSpan={12}>
                      {t.teamMatch.ruledAs(t.teamMatch.rulings[ruling.kind], teamName(t, match, ruling.team), ruling.reason)}
                    </Note>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </Grid>
    </Scroll>
  )
}
