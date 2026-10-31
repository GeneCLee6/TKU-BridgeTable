import type { Call } from '../../auction.ts'
import { narrow, union } from './combine.ts'
import { fitsPattern, tokens, type Ctx } from './context.ts'
import type { Book, Dynamic, Rule, Spec, System } from './spec.ts'

/** Finding the rules of a system (`spec.ts`) for an auction */

const patterns = new WeakMap<Book, string[][]>()

function patternsOf(book: Book): string[][] {
  let list = patterns.get(book)
  if (!list) {
    const after = book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after
    list = after.map(tokens)
    patterns.set(book, list)
  }
  return list
}

/** Whether a book is for this auction */
export function bookFits(book: Book, ctx: Ctx): boolean {
  const list = patternsOf(book)
  if (list.length && !list.some((p) => fitsPattern(p, ctx.key))) return false
  return !book.only || book.only(ctx)
}

/**
 * The rules for this auction, in order: books that fit, up to the first that is the last word. A
 * book that lets later books add rules (`more`) still has the last word on the calls it makes: the
 * later books' rules for those calls are left out, so their meanings stay the book's.
 */
export function rulesFor(system: System, ctx: Ctx): Rule[] {
  const rules: Rule[] = []
  const covered = new Set<Call>()
  for (const book of system.books) {
    if (!bookFits(book, ctx)) continue
    const made: Call[] = []
    for (const rule of book.rules) {
      const call = resolve(rule.call, ctx)
      if (call && covered.has(call)) continue
      rules.push(rule)
      if (call) made.push(call)
    }
    for (const call of made) covered.add(call)
    if (!book.more) break
  }
  return rules
}

export const resolve = <T>(value: Dynamic<T> | undefined, ctx: Ctx): T | undefined =>
  typeof value === 'function' ? (value as (ctx: Ctx) => T)(ctx) : value

/**
 * The call a rule makes here, if it is legal. When pass is not allowed, the only pass left is one
 * that leaves partner's double in for penalty
 */
export function callOf(rule: Rule, ctx: Ctx): Call | null {
  const call = resolve(rule.call, ctx) ?? null
  if (!call || !ctx.legal.has(call)) return null
  if (call === 'P' && ctx.forced && resolve(rule.shows, ctx)?.name !== 'penalty') return null
  return call
}

/**
 * What each call would show if made now, as GIB explains a call before you make it: the rules for
 * the auction that make that call, put together with `union`, and each feature narrowed to what
 * the caller has already shown (`narrow`, Y2): after 1NT (15–17) a later "6+" reads "15–17". This is
 * every explanation the players see and what partner reads the call as. Calls no rule makes are
 * left out.
 */
export function meanings(system: System, ctx: Ctx): Map<Call, Spec> {
  const byCall = new Map<Call, Spec[]>()
  for (const rule of rulesFor(system, ctx)) {
    const call = callOf(rule, ctx)
    if (!call) continue
    const list = byCall.get(call) ?? []
    list.push(resolve(rule.shows, ctx) ?? {})
    byCall.set(call, list)
  }
  const known = ctx.shown.me
  return new Map([...byCall].map(([call, specs]) => [call, narrow(union(specs), known)]))
}
