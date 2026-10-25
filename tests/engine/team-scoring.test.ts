import { describe, expect, it } from 'vitest'
import {
  defaultTeamMatchSettings,
  MATCH_SEATS,
  parseTeamMatchSettings,
  teamAt,
  TEAM_MATCH_LIMITS,
} from '../../shared/team-match.ts'
import { scoreTeamMatch, teamBoardResult, type TeamBoardScores } from '../../shared/team-scoring.ts'

/**
 * A four-board match worked out by hand (WBF IMP scale). Team A is North-South in the open room,
 * so A's net score is open NS − closed NS:
 *
 *   1  open 4♠= +420, closed 4♠-1 −50          net +470  → A 10 IMPs (430–490)
 *   2  open 2♥+1 +140, closed 3♠+1 +170        net −30   → B 1 IMP (20–40)
 *   3  East-West 4♥= −620 in both rooms        net 0     → push
 *   4  open 2♠X-1 −100, closed 4♠+1 vul +650   net −750  → B 13 IMPs (750–890)
 *   Total A 10 : B 14, B leads by 4
 */
const MATCH: TeamBoardScores[] = [
  { open: 420, closed: -50 },
  { open: 140, closed: 170 },
  { open: -620, closed: -620 },
  { open: -100, closed: 650 },
]

describe('team scoring (IMPs)', () => {
  it('scores a hand-worked four-board match', () => {
    const score = scoreTeamMatch('imp', MATCH)
    expect(score.boards).toEqual([
      { A: 10, B: 0, net: 470, ruled: false },
      { A: 0, B: 1, net: -30, ruled: false },
      { A: 0, B: 0, net: 0, ruled: false },
      { A: 0, B: 13, net: -750, ruled: false },
    ])
    expect(score.totals).toEqual({ A: 10, B: 14 })
    expect(score.completed).toBe(4)
    expect(score.leader).toBe('B')
  })

  it('waits for both rooms before a board counts', () => {
    const score = scoreTeamMatch('imp', [{ open: 420, closed: null }, { open: null, closed: null }, { open: 50, closed: -50 }])
    expect(score.boards[0]).toBeNull()
    expect(score.boards[1]).toBeNull()
    // 100 is 3 IMPs (90–120)
    expect(score.totals).toEqual({ A: 3, B: 0 })
    expect(score.completed).toBe(1)
    expect(score.leader).toBe('A')
  })

  it('scores rulings as ±3 IMPs and Avg as nothing, instead of the rooms’ scores', () => {
    expect(teamBoardResult('imp', { open: null, closed: null, ruling: { kind: 'avg', team: 'A' } })).toEqual({ A: 0, B: 0, ruled: true })
    expect(teamBoardResult('imp', { open: 420, closed: null, ruling: { kind: 'avgPlus', team: 'B' } })).toEqual({ A: 0, B: 3, ruled: true })
    expect(teamBoardResult('imp', { open: null, closed: 50, ruling: { kind: 'avgMinus', team: 'B' } })).toEqual({ A: 3, B: 0, ruled: true })
    // A ruling wins even over two played rooms
    expect(teamBoardResult('imp', { open: 420, closed: -50, ruling: { kind: 'avgMinus', team: 'A' } })).toEqual({ A: 0, B: 3, ruled: true })
  })

  it('is level when nothing has been scored or the totals are equal', () => {
    expect(scoreTeamMatch('imp', []).leader).toBeNull()
    expect(scoreTeamMatch('imp', [{ open: 100, closed: 0 }, { open: 0, closed: 100 }]).leader).toBeNull()
  })
})

describe('team scoring (BAM)', () => {
  it('gives 1 for a better net score and ½ for a tie, whatever the size', () => {
    const score = scoreTeamMatch('bam', MATCH)
    expect(score.boards.map((b) => b && [b.A, b.B])).toEqual([
      [1, 0],
      [0, 1],
      [0.5, 0.5],
      [0, 1],
    ])
    expect(score.totals).toEqual({ A: 1.5, B: 2.5 })
    expect(score.leader).toBe('B')
  })

  it('scores Avg as ½ each and Avg+ as 60% of the board', () => {
    expect(teamBoardResult('bam', { open: null, closed: null, ruling: { kind: 'avg', team: 'B' } })).toMatchObject({ A: 0.5, B: 0.5 })
    const plus = teamBoardResult('bam', { open: null, closed: null, ruling: { kind: 'avgPlus', team: 'A' } })!
    expect(plus.A).toBeCloseTo(0.6)
    expect(plus.B).toBeCloseTo(0.4)
    const minus = teamBoardResult('bam', { open: null, closed: null, ruling: { kind: 'avgMinus', team: 'A' } })!
    expect(minus.A).toBeCloseTo(0.4)
    expect(minus.B).toBeCloseTo(0.6)
  })
})

describe('team match seats and settings', () => {
  it('puts team A North-South in the open room and East-West in the closed room', () => {
    expect(MATCH_SEATS).toHaveLength(8)
    expect(MATCH_SEATS.map(({ room, seat }) => `${room}${seat}${teamAt(room, seat)}`)).toEqual([
      'openNA',
      'openEB',
      'openSA',
      'openWB',
      'closedNB',
      'closedEA',
      'closedSB',
      'closedWA',
    ])
  })

  it('fills in the defaults and keeps what it is given', () => {
    expect(parseTeamMatchSettings(undefined)).toEqual({ settings: defaultTeamMatchSettings() })
    expect(defaultTeamMatchSettings()).toMatchObject({ boards: 8, scoring: 'imp', boardMinutes: 10, robots: true, invite: 'direct' })
    const parsed = parseTeamMatchSettings({ teamNames: ['  淡江 ', '政大'], boards: 32, scoring: 'bam', boardMinutes: 0 })
    expect(parsed).toEqual({
      settings: { ...defaultTeamMatchSettings(), teamNames: ['淡江', '政大'], boards: 32, scoring: 'bam', boardMinutes: 0 },
    })
    // Changing settings starts from the match's own
    const base = { ...defaultTeamMatchSettings(), boards: 12 }
    expect(parseTeamMatchSettings({ robots: false }, base)).toEqual({ settings: { ...base, robots: false } })
  })

  it('names the first field that is wrong', () => {
    const field = (value: unknown) => {
      const parsed = parseTeamMatchSettings(value)
      return 'field' in parsed ? parsed.field : null
    }
    expect(field(null)).toBe('settings')
    expect(field([])).toBe('settings')
    expect(field({ robotLevel: 2 })).toBe('robotLevel')
    expect(field({ boards: TEAM_MATCH_LIMITS.boardsMin - 1 })).toBe('boards')
    expect(field({ boards: TEAM_MATCH_LIMITS.boardsMax + 1 })).toBe('boards')
    expect(field({ boards: 8.5 })).toBe('boards')
    expect(field({ scoring: 'mp' })).toBe('scoring')
    expect(field({ boardMinutes: 2 })).toBe('boardMinutes')
    expect(field({ boardMinutes: 31 })).toBe('boardMinutes')
    expect(field({ teamNames: ['A'] })).toBe('teamNames')
    expect(field({ teamNames: ['A', 'x'.repeat(21)] })).toBe('teamNames')
    expect(field({ teamNames: ['A', 'B\n'] })).toBe('teamNames')
    expect(field({ robots: 'yes' })).toBe('robots')
    expect(field({ robotKind: 'gib2' })).toBe('robotKind')
    expect(field({ invite: 'open' })).toBe('invite')
    expect(field({ teamNames: ['', ''], boards: 4, boardMinutes: 30, robotKind: 'tku', invite: 'captains' })).toBeNull()
  })
})
