import type { AuctionCall, Call } from './auction.ts'
import type { Vulnerability } from './board.ts'
import { sideOf, type Side, type Seat } from './cards.ts'
import { explain } from './robot/system/engine.ts'
import type { Convention, Spec, System } from './robot/system/spec.ts'

/**
 * The bidding hint card (`e10-t06`, AC-10.4): which pages of TKU BridgeBook (淡江橋譜) go with the
 * auction on the table. Each topic is a page of the book (`/c/<slug>`); it comes from the opening
 * (our side's, or the opponents' for the competition page) and from the conventions the club's
 * rules give the calls made so far and the calls that could come next.
 *
 * Until the rules carry their own `bookSlug` (`e5-t45`) the link goes by the convention's name,
 * here; when they do, the rule's own slug can replace this table. Addresses: `book-site.ts`.
 * Worked out on the server only (`worker/views.ts` puts it in `BoardView.bookTopics`): the browser
 * renders the list and never runs the engine (CLAUDE.md rule 1).
 */

/** The book's page for each convention the club's system names (the book's slugs, `src/content/conventions`) */
export const CONVENTION_PAGES: Partial<Record<Convention, string>> = {
  stayman: 'notrump-responses',
  smolen: 'notrump-responses',
  transfer: 'notrump-responses',
  superAccept: 'notrump-responses',
  texas: 'notrump-responses',
  minorStayman: 'notrump-responses',
  gerber: 'notrump-responses',
  quantitative: 'notrump-responses',
  jacoby2N: 'jacoby-2nt',
  j2n: 'jacoby-2nt',
  bergen: 'bergen-raises',
  limitRaise: 'system-one-major',
  preemptiveRaise: 'system-one-major',
  splinter: 'system-one-major',
  oneMajorWeakTwo: 'system-one-major',
  // 2♥／2♠ two-suiters: the handbook's 技光 (社長 2026-10-25)
  twoSuiter: 'system-competition',
  newMinorForcing: 'new-minor-forcing',
  lebensohl: 'lebensohl',
  responsive: 'responsive-double',
  takeout: 'system-doubles',
  negative: 'system-doubles',
  support: 'system-doubles',
  penalty: 'system-doubles',
  overcall: 'system-competition',
  weakJumpOvercall: 'system-competition',
  michaels: 'system-competition',
  unusual2N: 'system-competition',
  cueRaise: 'system-competition',
  unusualVsUnusual: 'defense-vs-unusual-2nt',
  strong2C: 'system-strong-and-preempts',
  waiting: 'system-strong-and-preempts',
  doubleNegative: 'system-strong-and-preempts',
  weakTwo: 'system-strong-and-preempts',
  featureAsk: 'system-strong-and-preempts',
  feature: 'system-strong-and-preempts',
  preempt: 'system-strong-and-preempts',
}

/** The book's page for each opening bid of the club's system */
export const OPENING_PAGES: Record<string, string> = {
  '1C': 'system-one-club',
  '1D': 'system-one-diamond',
  '1H': 'system-one-major',
  '1S': 'system-one-major',
  '1N': 'system-notrump',
  '2C': 'system-strong-and-preempts',
  '2D': 'two-diamond-opening',
  '2H': 'system-competition',
  '2S': 'system-competition',
  '2N': 'two-notrump-opening',
  '3C': 'system-strong-and-preempts',
  '3D': 'system-strong-and-preempts',
  '3H': 'system-strong-and-preempts',
  '3S': 'system-strong-and-preempts',
}

/** The page for bidding after the opponents open */
export const COMPETITION_PAGE = 'system-competition'

/** A page of the book and why it is shown: the opening, the opponents' opening, or conventions in the auction */
export type BookTopic =
  | { slug: string; kind: 'opening'; call: Call }
  | { slug: string; kind: 'competition' }
  | { slug: string; kind: 'convention'; conventions: Convention[] }

export interface BookTopics {
  /** From the auction so far: the opening first, then the conventions in the order they came up */
  soFar: BookTopic[]
  /** Pages for conventions the next call could use, not already listed (none once the auction is over) */
  next: BookTopic[]
}

/**
 * The book's pages for an auction, seen from `side` (the viewer's, or North-South for a watcher).
 * `over`: the auction has ended, so nothing comes next. `explainWith` lets the server reuse the
 * meanings it has already worked out for the same auction
 */
export function bookTopics(
  system: System,
  auction: readonly AuctionCall[],
  dealer: Seat,
  vul: Vulnerability,
  side: Side,
  over = false,
  explainWith: (system: System, auction: readonly AuctionCall[], dealer: Seat, vul: Vulnerability) => Map<Call, Spec> = explain,
): BookTopics {
  const soFar: BookTopic[] = []
  const seen = new Map<string, BookTopic>()
  const add = (list: BookTopic[], topic: BookTopic) => {
    const known = seen.get(topic.slug)
    if (!known) {
      seen.set(topic.slug, topic)
      list.push(topic)
    } else if (known.kind === 'convention' && topic.kind === 'convention')
      for (const name of topic.conventions) if (!known.conventions.includes(name)) known.conventions.push(name)
  }
  const conventionTopic = (name: Convention | undefined): BookTopic | null => {
    const slug = name && CONVENTION_PAGES[name]
    return slug ? { slug, kind: 'convention', conventions: [name] } : null
  }

  const opening = auction.find((c) => c.call !== 'P')
  if (opening && sideOf(opening.seat) === side) {
    const slug = OPENING_PAGES[opening.call]
    if (slug) add(soFar, { slug, kind: 'opening', call: opening.call })
  } else if (opening) add(soFar, { slug: COMPETITION_PAGE, kind: 'competition' })

  auction.forEach((made, i) => {
    if (made.call === 'P') return
    const topic = conventionTopic(explainWith(system, auction.slice(0, i), dealer, vul).get(made.call)?.name)
    if (topic) add(soFar, topic)
  })

  const next: BookTopic[] = []
  if (!over)
    for (const spec of explainWith(system, auction, dealer, vul).values()) {
      const topic = conventionTopic(spec.name)
      if (topic) add(next, topic)
    }
  return { soFar, next }
}
