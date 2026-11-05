import { bidIndex, isBid, seatToCall, type AuctionCall, type Call } from '../../auction.ts'
import type { Vulnerability } from '../../board.ts'
import { leadRows, signalRows, type LeadRow, type SignalRow } from '../card-play.ts'
import { patternAuction } from './book-spec.ts'
import type { Ctx } from './context.ts'
import { describe } from './describe.ts'
import { GIB } from './gib/index.ts'
import { contextFor } from './infer.ts'
import { bookFits, meanings, resolve } from './rules.ts'
import { neverFits, type Spec, type System, type SystemId } from './spec.ts'
import { TKU } from './tku/index.ts'
import { TKU_SOURCES } from './tku/sources.ts'

/**
 * The system card (e5-t52, AC-5.11): a readable summary of a bidding system, read off the same rules
 * the robot bids with, so it cannot drift from them. What is written by hand here is only the
 * index: which auctions each section shows. What every call means comes from the rules (`meanings`,
 * as the bidding box hints and the robot's alerts), in `Spec` form, so the browser words it in the
 * viewer's language with `describe.ts`; leads and signals are asked of the code that plays
 * (`card-play.ts`).
 *
 * This takes the whole engine, so it runs at build time only (the `virtual:system-cards` module,
 * `scripts/system-cards-plugin.ts`): the browser gets data, and no Worker request ever derives a
 * card (10 ms CPU). A card depends on the system alone: no table, no board, no hand reaches it.
 */

export const CARD_SECTIONS = ['openings', 'notrump', 'oneLevel', 'twoLevel', 'competitive', 'slam'] as const
export type CardSectionId = (typeof CARD_SECTIONS)[number]

export interface CardCall {
  call: Call
  /** What the call shows, as the rules say, both sides not vulnerable */
  shows: Spec
  /** What it shows when vulnerable, when the rules make that different */
  vulnerable?: Spec
  /** No rule makes the robot bid this; it only reads it when a person does */
  readOnly?: true
}

export interface CardGroup {
  /** The auction before the call, as `Book.after` writes it: opponents in brackets, '' is an opening */
  after: string
  /** An opening in third or fourth seat; only the calls that read differently there */
  seat?: 3 | 4
  calls: CardCall[]
}

export interface CardArticle {
  slug: string
  nameZh: string
}

export interface CardSection {
  id: CardSectionId
  groups: CardGroup[]
  /** The 淡江橋館 articles the rules shown here follow (the club's system only, `tku/sources.ts`) */
  articles: CardArticle[]
}

export interface SystemCard {
  system: SystemId
  sections: CardSection[]
  leads: LeadRow[]
  signals: SignalRow[]
}

interface GroupIndex {
  after: string
  seat?: 3 | 4
  /** Only these calls (the section is about them) */
  calls?: readonly Call[]
  /** Take the general books too (`Book.general`), for asks that live there */
  general?: boolean
}

/** Which auctions each section shows; a group whose auction has no agreements comes out empty and is left out */
const INDEX: Record<CardSectionId, readonly GroupIndex[]> = {
  openings: [{ after: '' }, { after: '', seat: 3 }, { after: '', seat: 4 }],
  notrump: [
    { after: '', calls: ['1N', '2N'] },
    { after: '1N (P)' },
    { after: '1N (P) 2C (P)' },
    { after: '1N (P) 2D (P)' },
    { after: '1N (P) 2H (P)' },
    { after: '2N (P)' },
  ],
  oneLevel: [{ after: '1C (P)' }, { after: '1D (P)' }, { after: '1H (P)' }, { after: '1S (P)' }, { after: '1S (P) 2N (P)' }],
  twoLevel: [
    { after: '', calls: ['2C', '2D', '2H', '2S'] },
    { after: '2C (P)' },
    { after: '2D (P)' },
    { after: '2H (P)' },
    { after: '2S (P)' },
  ],
  competitive: [
    { after: '(1H)' },
    { after: '(1N)' },
    { after: '(2S)' },
    { after: '(3H)' },
    { after: '(1H) P (P)' },
    { after: '(1H) X (P)' },
    { after: '(1H) 1S (P)' },
    { after: '1H (2C)' },
    { after: '1C (1H)' },
    { after: '1N (2H)' },
  ],
  slam: [
    { after: '1H (P) 1S (P) 2S (P)', calls: ['4N'], general: true },
    { after: '1S (P) 2N (P) 4N (P)' },
    { after: '1N (P) 4C (P)' },
    { after: '1H (P) 1S (P) 2C (P) 4N (P)' },
    { after: '1S (P) 2N (P) 4N (P) 5C (P) 5D (P)' },
    { after: '1S (P) 2N (P) 4N (P) 5S (P) 5N (P)' },
  ],
}

/** The call's place on the card: bids from the lowest, then doubles, then pass */
const order = (call: Call) => (isBid(call) ? bidIndex(call) : call === 'P' ? 1000 : 900)

const same = (a: Spec, b: Spec) => JSON.stringify(a) === JSON.stringify(b)

/** The system with only the rules that can make the robot bid, and without the general books unless asked */
function narrowed(system: System, general: boolean, bidsOnly: boolean): System {
  const books = system.books.filter((book) => general || !book.general)
  return { ...system, books: bidsOnly ? books.map((book) => ({ ...book, rules: book.rules.filter((rule) => rule.when !== neverFits) })) : books }
}

function contextAt(system: System, group: GroupIndex, vul: Vulnerability): Ctx | null {
  const played = patternAuction(group.after)
  if (!played) return null
  // Passes before the opening put the opener in third or fourth seat; book patterns leave them out
  const before: AuctionCall[] = Array.from({ length: (group.seat ?? 1) - 1 }, (_, i) => ({ seat: seatToCall('N', i), call: 'P' }))
  const auction: AuctionCall[] = [...before, ...played.map((c, i) => ({ ...c, seat: seatToCall('N', before.length + i) }))]
  return contextFor(system, seatToCall('N', auction.length), auction, 'N', vul)
}

function deriveGroup(system: System, index: GroupIndex): { group: CardGroup; ctx: Ctx } | null {
  const ctx = contextAt(system, index, 'None')
  const vulCtx = contextAt(system, index, 'Both')
  if (!ctx || !vulCtx) return null
  const rules = narrowed(system, !!index.general, false)
  const known = meanings(rules, ctx)
  const whenVul = meanings(rules, vulCtx)
  const bid = meanings(narrowed(system, !!index.general, true), ctx)
  const first = index.seat ? meanings(rules, contextAt(system, { after: index.after }, 'None')!) : null
  const calls: CardCall[] = []
  for (const [call, shows] of known) {
    if (index.calls && !index.calls.includes(call)) continue
    // A pass says little: only a named one (leaving partner's double in) is an agreement
    if (call === 'P' && !shows.name) continue
    if (!describe(shows, 'en')) continue
    const firstSeat = first?.get(call)
    if (first && (!firstSeat || same(firstSeat, shows))) continue
    const vulnerable = whenVul.get(call)
    calls.push({
      call,
      shows,
      ...(vulnerable && !same(vulnerable, shows) ? { vulnerable } : {}),
      ...(bid.has(call) ? {} : { readOnly: true as const }),
    })
  }
  calls.sort((a, b) => order(a.call) - order(b.call))
  return calls.length ? { group: { after: index.after, ...(index.seat ? { seat: index.seat } : {}), calls }, ctx } : null
}

/** The articles behind the calls a section shows: of the books for each auction, those that make one of them */
function articlesOf(system: System, found: readonly { group: CardGroup; ctx: Ctx }[]): CardArticle[] {
  const slugs = new Set<string>()
  for (const { group, ctx } of found) {
    const shown = new Set(group.calls.map((c) => c.call))
    for (const book of system.books) {
      if (!book.bookSlugs || !bookFits(book, ctx)) continue
      if (book.rules.some((rule) => shown.has(resolve(rule.call, ctx) ?? ''))) for (const slug of book.bookSlugs) slugs.add(slug)
    }
  }
  return TKU_SOURCES.filter((source) => slugs.has(source.slug)).map(({ slug, nameZh }) => ({ slug, nameZh }))
}

/** The card of a system. Takes the system only: nothing about any table or board can reach a card */
export function deriveCard(system: System): SystemCard {
  const sections = CARD_SECTIONS.map((id): CardSection => {
    // The same answers after another auction say nothing new (2/1's Blackwood auction reads as RKCB);
    // third and fourth seat keep a group each even when they read the same
    const seen = new Set<string>()
    const found = INDEX[id].flatMap((index) => {
      const derived = deriveGroup(system, index)
      if (!derived) return []
      const key = JSON.stringify(derived.group.calls)
      if (!index.seat && seen.has(key)) return []
      seen.add(key)
      return [derived]
    })
    return { id, groups: found.map((f) => f.group), articles: articlesOf(system, found) }
  })
  return { system: system.id, sections, leads: leadRows(), signals: signalRows(system.id) }
}

export type SystemCards = Record<SystemId, SystemCard>

/** Both cards, as the site ships them */
export const deriveCards = (): SystemCards => ({ tku: deriveCard(TKU), gib: deriveCard(GIB) })
