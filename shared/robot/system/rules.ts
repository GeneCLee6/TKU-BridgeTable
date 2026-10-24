import type { Call } from '../../auction.ts'
import { union } from './combine.ts'
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

/** The rules for this auction, in order: books that fit, up to the first that is the last word */
export function rulesFor(system: System, ctx: Ctx): Rule[] {
  const rules: Rule[] = []
  for (const book of system.books) {
    if (!bookFits(book, ctx)) continue
    rules.push(...book.rules)
    if (!book.more) break
  }
  return rules
}

export const resolve = <T>(value: Dynamic<T> | undefined, ctx: Ctx): T | undefined =>
  typeof value === 'function' ? (value as (ctx: Ctx) => T)(ctx) : value

/** The call a rule makes here, if it is legal (and not a pass when pass is not allowed) */
export function callOf(rule: Rule, ctx: Ctx): Call | null {
  const call = resolve(rule.call, ctx) ?? null
  if (!call || !ctx.legal.has(call)) return null
  return call === 'P' && ctx.forced ? null : call
}

/**
 * What each call would show if made now, as GIB explains a call before you make it: the rules for
 * the auction that make that call, put together with `union`. Calls no rule makes are left out.
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
  return new Map([...byCall].map(([call, specs]) => [call, union(specs)]))
}
