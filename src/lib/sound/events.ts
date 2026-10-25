/**
 * Which sound plays when (DESIGN.md §4「音效」, decided from docs/design/sound/SOUND-proposal.md):
 * the events, how loud each is next to "your call" (dB, 0 the loudest), and the rules for when one
 * does not play. Pure, so the rules are tested without any audio.
 */

export type SoundStyle = 'table' | 'digital' | 'off'
export type SoundVolume = 'soft' | 'medium' | 'loud'

export const SOUND_STYLES: readonly SoundStyle[] = ['table', 'digital', 'off']
export const SOUND_VOLUMES: readonly SoundVolume[] = ['soft', 'medium', 'loud']

/** The member's volume as a gain on every sound */
export const VOLUME_DB: Record<SoundVolume, number> = { soft: -12, medium: -6, loud: 0 }

/**
 * - call: wants you to do something (always the clearest; the only ones in a background tab)
 * - event: worth knowing, nothing to do now
 * - ambient: what is going on at the table
 */
export type SoundLevel = 'call' | 'event' | 'ambient'

export const SOUND_EVENTS = {
  /** #1 A new board is dealt */
  deal: { db: -6, level: 'ambient' },
  /** #2 A card you played (or, as declarer, dummy's) lands on the table */
  card: { db: -8, level: 'ambient' },
  /** #3 Anyone else's card: quieter and a little duller, so it is plainly not yours */
  otherCard: { db: -12, level: 'ambient' },
  /** #4 A trick is taken off the table: very soft, the same for either side */
  trick: { db: -16, level: 'ambient' },
  /** #5 Your call */
  turn: { db: 0, level: 'call', vibrate: [40] },
  /** #6 Your card: only while the tab is in the background */
  turnPlay: { db: 0, level: 'call', vibrate: [40] },
  /** #7 Someone else's call; off unless the member turns bid sounds on */
  bid: { db: -18, level: 'ambient' },
  pass: { db: -22, level: 'ambient' },
  /** #8 A claim or an undo waits on your answer */
  attention: { db: 0, level: 'call', vibrate: [30, 60, 30] },
  /** #9 The board is over: made, down or passed out; never "us" or "them" */
  made: { db: -6, level: 'event' },
  down: { db: -8, level: 'event' },
  passout: { db: -10, level: 'event' },
  /** #10 You have kept the table waiting a while */
  slow: { db: -4, level: 'call', vibrate: [40, 80, 40] },
  /** #11 Table chat, while the chat panel is not showing or the tab is in the background */
  chat: { db: -18, level: 'ambient' },
  /** #12 A direct message or a notification */
  notify: { db: -8, level: 'event' },
  /** #13 Someone sat down at your table, or it is full and can start (you are the host) */
  seat: { db: -12, level: 'event' },
  full: { db: -12, level: 'event' },
  /** #14 A challenge's results are out */
  challengeResult: { db: -8, level: 'event' },
  /** #15 Your team match has started */
  matchStart: { db: -6, level: 'event' },
  /** #16 The other room's result came in (people watching a match only) */
  score: { db: -16, level: 'event' },
  /** #17 A team match is over: the same sound whoever won */
  matchEnd: { db: -6, level: 'event' },
} as const satisfies Record<string, { db: number; level: SoundLevel; vibrate?: readonly number[] }>

export type SoundEvent = keyof typeof SOUND_EVENTS

interface SoundSpec {
  db: number
  level: SoundLevel
  vibrate?: readonly number[]
}
const SPECS: Record<SoundEvent, SoundSpec> = SOUND_EVENTS

/** The member's sound settings (from PreferencesContext) */
export interface SoundPrefs {
  /** The header's speaker button */
  sound: boolean
  soundStyle: SoundStyle
  soundVolume: SoundVolume
  /** Other people's calls (#7) */
  soundBids: boolean
  /** Table chat (#11) */
  soundChat: boolean
  /** Deal, cards and tricks at a table one only watches (and a match's other room, #16) */
  soundKibitz: boolean
  /** A short buzz on a phone for the "call" sounds (Android; iPhone Safari cannot) */
  vibrate: boolean
}

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  sound: true,
  soundStyle: 'table',
  soundVolume: 'medium',
  soundBids: false,
  soundChat: true,
  soundKibitz: true,
  vibrate: false,
}

/** Where the event happens */
export interface SoundSituation {
  /** The tab is in the background */
  hidden: boolean
  /** The member only watches this table */
  kibitzing?: boolean
}

/** What watchers hear: what happens on the felt, and the other room's result in a team match */
const KIBITZ_EVENTS: ReadonlySet<SoundEvent> = new Set(['deal', 'card', 'otherCard', 'trick', 'score'])
/** What a background tab still plays: what needs you, and messages */
const BACKGROUND_EVENTS: ReadonlySet<SoundEvent> = new Set(['turn', 'turnPlay', 'attention', 'slow', 'notify', 'chat'])

/** Whether the event makes a sound, and whether it buzzes the phone */
export function soundDecision(event: SoundEvent, prefs: SoundPrefs, where: SoundSituation): { sound: boolean; vibrate: boolean } {
  const spec = SPECS[event]
  if (where.kibitzing && (!KIBITZ_EVENTS.has(event) || !prefs.soundKibitz)) return { sound: false, vibrate: false }
  // A buzz is for what needs you, and it does not depend on the speaker (that is its point in class)
  const vibrate = prefs.vibrate && !!spec.vibrate
  let sound = prefs.sound && prefs.soundStyle !== 'off'
  if (where.hidden && !BACKGROUND_EVENTS.has(event)) sound = false
  if ((event === 'bid' || event === 'pass') && !prefs.soundBids) sound = false
  if (event === 'chat' && !prefs.soundChat) sound = false
  return { sound, vibrate }
}

/** The linear gain for an event at the member's volume */
export function eventGain(event: SoundEvent, volume: SoundVolume): number {
  return Math.pow(10, (SOUND_EVENTS[event].db + VOLUME_DB[volume]) / 20)
}

/** The vibration pattern for an event, if it has one (ms) */
export function vibrationOf(event: SoundEvent): number[] | null {
  const spec = SPECS[event]
  return spec.vibrate ? [...spec.vibrate] : null
}

/** Within this long the same sound plays once (ms); your call a little longer, so it never doubles */
export function throttleMs(event: SoundEvent): number {
  return event === 'turn' || event === 'turnPlay' ? 500 : event === 'chat' ? 3000 : 120
}
