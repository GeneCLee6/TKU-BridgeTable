import type { Team } from '../../shared/team-scoring.ts'
import { arrangerOf, type MatchSeat, type MatchSeatView, type TeamMatchView } from '../../shared/team-match.ts'
import type { Strings } from '../strings.ts'

/** What the team match pages work out from a `TeamMatchView` (ARCHITECTURE.md §5.8) */

/** A team's name, or 「A 隊」 in the viewer's language when the host left it empty */
export const teamName = (t: Strings, m: TeamMatchView, team: Team) =>
  m.settings.teamNames[team === 'A' ? 0 : 1] || t.teamMatch.team(team)

/** 開室南 */
export const seatLabel = (t: Strings, s: MatchSeat) => t.teamMatch.seatLabel(t.teamMatch.rooms[s.room], t.seatNames[s.seat])

/** 8 副 · IMP · TKB（2/1） */
export const matchSettingsLine = (t: Strings, m: TeamMatchView) =>
  t.teamMatch.settingsLine(m.settings.boards, t.teamMatch.scorings[m.settings.scoring], t.robots[m.settings.robotKind])

export const sameSeat = (a: MatchSeat, b: MatchSeat) => a.room === b.room && a.seat === b.seat

/** The seat the member is invited to or sits in */
export const mySeat = (m: TeamMatchView, userId: string) => m.seats.find((s) => s.userId === userId)

/** Whether the member arranges this seat's team (`e8-t05`); the server checks it again */
export const arranges = (m: TeamMatchView, userId: string, seat: MatchSeatView) =>
  m.status === 'setup' && arrangerOf(m, seat.team) === userId

/**
 * Robots in seats that do not match between the rooms (the open room's North against the closed
 * room's North, and so on): then the same board is played by different mixes of people and robots,
 * which the prep room points out (§5.8)
 */
export function robotsUneven(m: TeamMatchView): boolean {
  const robotAt = (room: 'open' | 'closed', seat: string) => m.seats.some((s) => s.room === room && s.seat === seat && s.robot)
  return (['N', 'E', 'S', 'W'] as const).some((seat) => robotAt('open', seat) !== robotAt('closed', seat))
}
