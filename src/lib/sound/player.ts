/**
 * Plays the table's sounds by the rules in `events.ts`: the member's settings, whether the tab is
 * in the background or the member only watches, the same sound at most once in a short while, and
 * news (a message, a challenge's results) held back while the member is playing a card, so it
 * never lands on top of the cards. Sounds never say anything the screen does not show as well.
 */

import { eventGain, soundDecision, throttleMs, vibrationOf, type SoundEvent, type SoundPrefs, type SoundStyle, type SoundVolume } from './events.ts'
import { synthesize, unlockAudio } from './synth.ts'

export { unlockAudio }

export interface CueOptions {
  /** Seconds from now, e.g. when a played card lands */
  delay?: number
  kibitzing?: boolean
  /** Throttles by this key instead of the event (chat: per person) */
  key?: string
}

const last = new Map<string, number>()

function hidden() {
  return typeof document !== 'undefined' && document.hidden
}

function buzz(pattern: number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Not allowed here (iPhone Safari has no vibration at all): the screen says it anyway
  }
}

/** Plays an event if the settings and the moment allow it; returns whether it did anything */
export function cue(event: SoundEvent, prefs: SoundPrefs, options: CueOptions = {}): boolean {
  const { sound, vibrate } = soundDecision(event, prefs, { hidden: hidden(), kibitzing: options.kibitzing })
  if (!sound && !vibrate) return false
  const key = options.key ?? event
  const now = Date.now()
  if (now - (last.get(key) ?? -Infinity) < throttleMs(event)) return false
  last.set(key, now)
  if (sound && prefs.soundStyle !== 'off') synthesize(prefs.soundStyle, event, options.delay ?? 0, eventGain(event, prefs.soundVolume))
  const pattern = vibrationOf(event)
  if (vibrate && pattern) buzz(pattern)
  return true
}

/** A few sounds of a style at a volume, for the 試聽 button: your call, two cards, a trick, made */
export function preview(style: Exclude<SoundStyle, 'off'>, volume: SoundVolume) {
  unlockAudio()
  const steps: [SoundEvent, number][] = [
    ['turn', 0],
    ['card', 0.6],
    ['otherCard', 1.1],
    ['trick', 1.6],
    ['made', 2.2],
  ]
  for (const [event, at] of steps) synthesize(style, event, at, eventGain(event, volume))
}

// ── News held back while the member is playing ──

/** What the member is doing at a table: news waits for a trick to be taken, results for the board's end */
export type TableActivity = 'none' | 'auction' | 'play'

let activity: TableActivity = 'none'
let held: { event: SoundEvent; prefs: SoundPrefs; until: 'trick' | 'board' }[] = []

function release(which: 'trick' | 'board') {
  const now = held.filter((h) => which === 'board' || h.until === 'trick')
  held = held.filter((h) => !now.includes(h))
  for (const h of now) cue(h.event, h.prefs)
}

/** The table page says what the member is doing there ('none' when they leave it or only watch) */
export function setTableActivity(next: TableActivity) {
  if (next === activity) return
  activity = next
  if (next === 'none') release('board')
  else if (next === 'auction') release('trick')
}

/** A trick was taken off the table: a message held back during it plays now */
export function trickTaken() {
  release('trick')
}

/**
 * A message, a notification or a challenge's results (#12, #14). During the play a message waits
 * until the trick is taken; a challenge's results wait until the board is over.
 */
export function cueNews(event: SoundEvent, prefs: SoundPrefs) {
  const until = event === 'challengeResult' ? (activity === 'none' ? null : 'board') : activity === 'play' ? 'trick' : null
  if (until) held.push({ event, prefs, until })
  else cue(event, prefs)
}

// ── What is on screen, so a message the member can already see makes no sound ──

let chatShown = 0
let conversationOpen: string | null = null

/** The table's chat panel is showing (call the returned function when it closes) */
export function showChat(): () => void {
  chatShown++
  return () => {
    chatShown--
  }
}

export function chatShowing() {
  return chatShown > 0
}

/** A direct message conversation is open with this member */
export function openConversation(userId: string): () => void {
  conversationOpen = userId
  return () => {
    if (conversationOpen === userId) conversationOpen = null
  }
}

export function conversationShowing(userId: string) {
  return conversationOpen === userId && !hidden()
}

/** Tests only: forget what played and what is held */
export function resetSoundState() {
  last.clear()
  held = []
  activity = 'none'
  chatShown = 0
  conversationOpen = null
}
