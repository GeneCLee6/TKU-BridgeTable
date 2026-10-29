import { isAuctionComplete, legalCalls, type AuctionCall, type BookNote, type Call } from '../../auction.ts'
import { nextSeat, type Seat } from '../../cards.ts'
import { CLUB_PROFILE_ID, type RobotShows, type RobotMeaningsItem, type RobotMeaningsQuery } from '../../protocol.ts'
import type { SystemSpec } from '../../systemSpec.ts'
import { patternProblem, tokens } from './context.ts'
import { describe } from './describe.ts'
import { explain } from './engine.ts'
import type { Spec, System } from './spec.ts'

/**
 * 淡江橋館's rules next to the robot's (BridgeHall e7-t03, e7-t04; AC-7.1, AC-7.2).
 *
 * A profile's `SystemSpec` (`shared/systemSpec.ts`) is made in the handbook and synced here
 * (`worker/system-spec.ts`). Two things use it:
 *
 * - `bookNotes` and `bookNoteFor`: when TKB bids in the club's system, its call carries the
 *   handbook's words for that call after that auction (`AuctionCall.book`), word for word. The
 *   robot still bids by its own rules (`tku/`), which the club has checked; the words are the
 *   handbook's, so a call whose rule and words disagree shows up on the report page.
 * - `robotMeanings`: what the robot's rules say each call shows after an auction, for the report
 *   page to set beside the handbook's (`explain`, from the auction alone).
 */

/** The key of a call after an auction: the `Book.after` pattern and the call */
export const bookKey = (after: string, call: Call) => `${after}|${call}`

/** The handbook's words for each call, by `bookKey`; `key` tells one synced spec from another */
export interface BookNotes {
  key: string
  notes: Record<string, BookNote>
}

/**
 * The words for each pattern and call, from `profile`'s spec. When two rows of the handbook give the same call after the
 * same auction different words, neither is used: the robot cannot tell which one it is following
 */
export function bookNotes(spec: SystemSpec, key: string, profile?: string): BookNotes {
  const notes: Record<string, BookNote> = {}
  const clash = new Set<string>()
  // The club's own profile is what the handbook shows anyway: its links need not name it
  const linked = profile && profile !== CLUB_PROFILE_ID ? { profile } : {}
  for (const rule of spec.rules) {
    for (const after of rule.after) {
      const k = bookKey(after, rule.call)
      const note: BookNote = { text: rule.text, slug: rule.ref.slug, sectionId: rule.ref.sectionId, ...linked }
      const known = notes[k]
      if (known && known.text !== note.text) clash.add(k)
      else if (!known) notes[k] = note
    }
  }
  for (const k of clash) delete notes[k]
  return { key, notes }
}

/**
 * The auction as a book pattern from the point of view of the seat about to call: from the opening
 * on (passes before it are left out), our side's calls as they are and the opponents' in brackets
 */
export function auctionPattern(auction: readonly Pick<AuctionCall, 'call'>[]): string {
  const opening = auction.findIndex((c) => c.call !== 'P')
  if (opening < 0) return ''
  const n = auction.length
  return auction
    .slice(opening)
    .map((c, i) => ((n - opening - i) % 2 === 1 ? `(${c.call})` : c.call))
    .join(' ')
}

/** The handbook's words for `call` made after `auction`, if it has any */
export function bookNoteFor(notes: BookNotes | null | undefined, auction: readonly Pick<AuctionCall, 'call'>[], call: Call): BookNote | undefined {
  return notes?.notes[bookKey(auctionPattern(auction), call)]
}

/** The auction a pattern stands for, dealt by North; null when it is not a plain, legal auction */
export function patternAuction(after: string): AuctionCall[] | null {
  if (patternProblem(after)) return null
  const auction: AuctionCall[] = []
  let seat: Seat = 'N'
  for (const token of tokens(after)) {
    const call = token.startsWith('(') ? token.slice(1, -1) : token
    // Wildcards are the robot's own; the handbook's patterns never have them
    if (call === '*' || call === '+') return null
    if (!legalCalls(auction, 'N').has(call)) return null
    auction.push({ seat, call })
    seat = nextSeat(seat)
  }
  return isAuctionComplete(auction) ? null : auction
}

/** The parts of what the robot's rule shows that the handbook's patterns read, and its words */
function robotShows(spec: Spec): RobotShows {
  const shows: RobotShows = { text: describe(spec, 'zh') }
  if (spec.name) shows.name = spec.name
  if (spec.hcp) shows.hcp = spec.hcp
  if (spec.len && Object.keys(spec.len).length) shows.len = spec.len
  if (spec.balanced !== undefined) shows.balanced = spec.balanced
  if (spec.forcing) shows.forcing = spec.forcing
  return shows
}

/**
 * What the robot's rules say each asked call shows after each auction: null when no rule makes the
 * call there (or the pattern is not an auction). From the auction alone, as the bidding box hints
 */
export function robotMeanings(system: System, query: RobotMeaningsQuery): RobotMeaningsItem[] {
  return query.items.map(({ after, calls }) => {
    const auction = patternAuction(after)
    const known = auction ? explain(system, auction, 'N', 'None') : new Map<Call, Spec>()
    const meanings: Record<string, RobotShows | null> = {}
    for (const call of calls) {
      const spec = known.get(call)
      meanings[call] = spec ? robotShows(spec) : null
    }
    return { after, meanings }
  })
}
