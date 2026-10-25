import { useCallback, useEffect, useMemo, useRef } from 'react'
import { partnerOf, SEATS, type Seat } from '../../../shared/cards.ts'
import { ROBOT_PREFIX, type DirectMessage, type NotificationsView, type TableView } from '../../../shared/protocol.ts'
import type { TeamMatchView } from '../../../shared/team-match.ts'
import { usePreferences } from '../../state/PreferencesContext.tsx'
import { PACE } from '../motion.ts'
import type { SoundEvent, SoundPrefs } from './events.ts'
import { chatShowing, conversationShowing, cue, cueNews, setTableActivity, trickTaken, unlockAudio, type CueOptions } from './player.ts'

/**
 * Where the app's sounds are triggered (DESIGN.md §4「音效」). The rules shared by every event
 * (settings, background tab, watching, throttling) are in `events.ts` and `player.ts`; these hooks
 * only notice what changed. What was already there when a page opened, or came back with a
 * reconnection, is not news: only changes after that make a sound. Replays (board records, the
 * last-trick window) never call these.
 */

/** The member's sound settings */
export function useSoundPrefs(): SoundPrefs {
  const { sound, soundStyle, soundVolume, soundBids, soundChat, soundKibitz, vibrate } = usePreferences()
  return useMemo(
    () => ({ sound, soundStyle, soundVolume, soundBids, soundChat, soundKibitz, vibrate }),
    [sound, soundStyle, soundVolume, soundBids, soundChat, soundKibitz, vibrate],
  )
}

/** A function that plays an event with the member's settings */
export function useCue() {
  const prefs = useSoundPrefs()
  return useCallback((event: SoundEvent, options?: CueOptions) => cue(event, prefs, options), [prefs])
}

const isRobot = (id: string) => id.startsWith(ROBOT_PREFIX)

export interface TableSoundInput {
  table: TableView
  /** The signed-in member */
  userId: string | undefined
  /** The member runs this table (not a challenge, practice or match table) */
  host: boolean
  /** Cards on the table so far, counting one just clicked and not yet confirmed */
  playedCount: number
  /** Who played the latest of them */
  lastPlayer: Seat | null
  /** Changes as each finished trick starts to leave the table */
  collecting: string | undefined
  myTurn: 'call' | 'play' | null
  /** The member has kept the table waiting a while (AC-2.10) */
  slow: boolean
}

interface Snapshot {
  boardNo: number
  played: number
  collecting: string | undefined
  finished: boolean
  calls: number
  answer: string
  myTurn: 'call' | 'play' | null
  slow: boolean
  seats: (string | null)[]
  chatLast: string | undefined
}

function snapshot(input: TableSoundInput): Snapshot {
  const { table, playedCount, collecting, myTurn, slow } = input
  const board = table.board
  const me = table.mySeat
  // A claim or an undo that waits on the member's answer
  const claim = board?.claim
  const claimWaits = !!me && !!claim && claim.seat !== me && claim.approvers.includes(me) && !claim.accepted.includes(me)
  const undo = board?.undo
  const undoWaits = !!me && !!undo && undo.seat !== me && undo.seat !== partnerOf(me)
  return {
    boardNo: board?.boardNo ?? 0,
    played: playedCount,
    collecting,
    finished: board?.phase === 'finished',
    calls: board?.auction.length ?? 0,
    answer: claimWaits ? `claim:${claim.seat}:${claim.tricks}` : undoWaits ? `undo:${undo.seat}` : '',
    myTurn,
    slow,
    seats: SEATS.map((s) => table.seats[s]?.id ?? null),
    chatLast: table.chat.at(-1)?.id,
  }
}

/** The board's end as a sound: made or down, never whether it was good for the member */
function resultEvent(table: TableView): SoundEvent | null {
  const board = table.board
  if (!board?.result) return null
  if (!board.contract) return 'passout'
  return board.result.declarerTricks >= board.contract.level + 6 ? 'made' : 'down'
}

/** Every sound at a table: the deal, cards, tricks, calls, your turn, answers, the result, chat and seats */
export function useTableSounds(input: TableSoundInput) {
  const prefs = useSoundPrefs()
  const now = snapshot(input)
  const last = useRef(now)
  const turnEndedAt = useRef(0)
  const { table } = input
  const me = table.mySeat
  const kibitzing = !me

  // What the member is doing here, so news waits for the trick (or the board) to finish
  const activity = me && table.board && table.board.phase !== 'finished' ? table.board.phase : 'none'
  useEffect(() => {
    setTableActivity(activity)
  }, [activity])
  useEffect(() => () => setTableActivity('none'), [])

  useEffect(() => {
    const before = last.current
    last.current = now
    if (before === now) return
    const play = (event: SoundEvent, options: CueOptions = {}) => cue(event, prefs, { kibitzing, ...options })
    const board = table.board

    // A new board: the shuffle, and nothing else from it yet
    if (now.boardNo !== before.boardNo) {
      if (now.boardNo) play('deal')
      return
    }

    // A card: it sounds as it lands, when the glide is all but done (PACE). Several at once (a
    // reconnection, two robot cards together) make one sound
    const carded = now.played > before.played
    if (carded) {
      const seat = input.lastPlayer
      const mine = !!me && (seat === me || (board?.contract?.declarer === me && seat === partnerOf(me)))
      play(mine ? 'card' : 'otherCard', { delay: PACE.landsAfterS })
    }

    if (now.collecting && now.collecting !== before.collecting) {
      play('trick')
      trickTaken()
    }

    // Another player's call (off unless the member turned bid sounds on)
    if (board && now.calls > before.calls) {
      const call = board.auction.at(-1)
      if (call && call.seat !== me) play(call.call === 'P' ? 'pass' : 'bid')
    }

    // Your turn: a call always; a card only while the tab is in the background (the screen says it)
    if (before.myTurn && !now.myTurn) turnEndedAt.current = Date.now()
    if (now.myTurn && now.myTurn !== before.myTurn) {
      if (now.myTurn === 'call' && Date.now() - turnEndedAt.current > 500) play('turn')
      else if (now.myTurn === 'play' && document.hidden) play('turnPlay')
    }

    if (now.answer && now.answer !== before.answer) play('attention')
    if (now.slow && !before.slow) play('slow')

    // The board is over: after the last card lands
    if (now.finished && !before.finished) {
      const event = resultEvent(table)
      if (event) play(event, { delay: carded ? PACE.landsAfterS + 0.25 : 0 })
    }

    // Someone sat down at the member's table (not a robot, not the member)
    if (input.host) {
      const came = now.seats.some((id, i) => id && id !== before.seats[i] && !isRobot(id) && id !== input.userId)
      if (came) play(now.seats.every(Boolean) && !before.seats.every(Boolean) ? 'full' : 'seat')
    }

    // Chat the member cannot see right now: the panel is closed or the tab is in the background
    if (now.chatLast !== before.chatLast && before.chatLast !== undefined) {
      const from = table.chat.findIndex((m) => m.id === before.chatLast)
      const fresh = from < 0 ? [] : table.chat.slice(from + 1)
      if (!chatShowing() || document.hidden)
        for (const m of fresh)
          if (m.userId !== input.userId && !isRobot(m.userId)) play('chat', { key: `chat:${m.userId}` })
    }
  })
}

/** The other room's result coming in at a team match, for people watching it (#16) */
export function useMatchScoreSound(match: TeamMatchView | null | undefined, watching: boolean) {
  const prefs = useSoundPrefs()
  const results = match?.boards.length
  const last = useRef(results)
  useEffect(() => {
    const before = last.current
    last.current = results
    if (watching && before !== undefined && results !== undefined && results > before) cue('score', prefs, { kibitzing: true })
  }, [results, watching, prefs])
}

const newest = (list: DirectMessage[]) => list.reduce((max, m) => Math.max(max, m.id), 0)

const NEWS: Partial<Record<string, SoundEvent>> = {
  matchStarted: 'matchStart',
  matchFinished: 'matchEnd',
  challengeResults: 'challengeResult',
}

/**
 * The sounds outside a table: notifications (a team match starting or ending, a challenge's
 * results, everything else the bell), direct messages from others in a conversation that is not
 * open, and the first click or key press, which lets the browser play sound at all
 */
export function useClubSounds(input: { userId: string | undefined; notifications: NotificationsView | null; directs: DirectMessage[] }) {
  const prefs = useSoundPrefs()
  const { userId, notifications, directs } = input

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio)
    window.addEventListener('keydown', unlockAudio)
    return () => {
      window.removeEventListener('pointerdown', unlockAudio)
      window.removeEventListener('keydown', unlockAudio)
    }
  }, [])

  // The notifications there when the page opened are not news
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!notifications) return
    const ids = notifications.items.map((n) => n.id)
    if (!seen.current) {
      seen.current = new Set(ids)
      return
    }
    const known = seen.current
    const fresh = notifications.items.filter((n) => !known.has(n.id))
    for (const id of ids) known.add(id)
    // Several at once make one sound: the most telling one
    const events = fresh.map((n) => NEWS[n.kind] ?? 'notify')
    const event = (['matchEnd', 'matchStart', 'challengeResult', 'notify'] as const).find((e) => events.includes(e))
    if (event) cueNews(event, prefs)
  }, [notifications, prefs])

  // Message ids grow with time, so the newest one seen marks what is news
  const directsSeen = useRef(newest(directs))
  useEffect(() => {
    const fresh = directs.filter((m) => m.id > directsSeen.current)
    directsSeen.current = Math.max(directsSeen.current, newest(directs))
    if (fresh.some((m) => m.from !== userId && !conversationShowing(m.from))) cueNews('notify', prefs)
  }, [directs, userId, prefs])
}
