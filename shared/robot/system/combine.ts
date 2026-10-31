import { SUITS, type Suit } from '../../cards.ts'
import { ANY, QUALITIES, STOPS, type Note, type Range, type Spec } from './spec.ts'

/**
 * GIB's two ways of putting specifications together (GIB Bid Descriptions):
 *
 * - `union`: several rules make the same call, so the call shows only what they all show, each
 *   feature at its widest ("4+ total points, 2+ cards" for a raise that is either weak with four
 *   trumps or strong with two).
 * - `intersect`: one player made several calls, so each feature takes the narrowest range any of
 *   them showed.
 *
 * And `narrow` (Y2): a call's own meaning, each feature it mentions narrowed to what the player
 * had already shown, which is how every explanation is shown ("11–15", not "6+", after 1NT).
 */

const widest = (ranges: readonly (Range | undefined)[]): Range | undefined =>
  ranges.every((r) => r) ? [Math.min(...ranges.map((r) => r![0])), Math.max(...ranges.map((r) => r![1]))] : undefined

const weakest = <T extends string>(ladder: readonly T[], values: readonly (T | undefined)[]): T | undefined =>
  values.every((v) => v) ? values.reduce((a, b) => (ladder.indexOf(a!) <= ladder.indexOf(b!) ? a : b)) : undefined

const same = <T>(values: readonly T[]): T | undefined =>
  values.length && values.every((v) => JSON.stringify(v) === JSON.stringify(values[0])) ? values[0] : undefined

function perSuit<T>(specs: readonly Spec[], pick: (spec: Spec) => Partial<Record<Suit, T>> | undefined, merge: (values: (T | undefined)[]) => T | undefined) {
  const out: Partial<Record<Suit, T>> = {}
  for (const s of SUITS) {
    const value = merge(specs.map((spec) => pick(spec)?.[s]))
    if (value !== undefined) out[s] = value
  }
  return Object.keys(out).length ? out : undefined
}

/** What a call shows when any of these rules may have made it */
export function union(specs: readonly Spec[]): Spec {
  if (specs.length === 0) return {}
  if (specs.length === 1) return specs[0]
  const out: Spec = {}
  const set = <K extends keyof Spec>(key: K, value: Spec[K] | undefined) => {
    if (value !== undefined) out[key] = value
  }
  set('name', same(specs.map((s) => s.name)))
  set('hcp', widest(specs.map((s) => s.hcp)))
  set('tp', widest(specs.map((s) => s.tp)))
  set('controls', widest(specs.map((s) => s.controls)))
  set('len', perSuit(specs, (s) => s.len, widest))
  set('quality', perSuit(specs, (s) => s.quality, (v) => weakest(QUALITIES, v)))
  set('stop', perSuit(specs, (s) => s.stop, (v) => weakest(STOPS, v)))
  set('balanced', same(specs.map((s) => s.balanced)))
  set('trump', same(specs.map((s) => s.trump)))
  set('trumpQueen', same(specs.map((s) => s.trumpQueen)))
  if (specs.every((s) => s.keycards)) set('keycards', [...new Set(specs.flatMap((s) => s.keycards!))].sort((a, b) => a - b))
  if (specs.every((s) => s.forcing)) set('forcing', specs.some((s) => s.forcing === 'oneRound') ? 'oneRound' : 'game')
  if (specs.every((s) => s.artificial)) set('artificial', true)
  const notes = (specs[0].notes ?? []).filter((n: Note) => specs.every((s) => s.notes?.some((m) => JSON.stringify(m) === JSON.stringify(n))))
  if (notes.length) set('notes', notes)
  return out
}

/** Narrowest of two ranges; when they do not overlap the newer one wins (the player changed their mind) */
function narrowest(known: Range | undefined, shown: Range | undefined): Range | undefined {
  if (!known) return shown
  if (!shown) return known
  const range: Range = [Math.max(known[0], shown[0]), Math.min(known[1], shown[1])]
  return range[0] <= range[1] ? range : shown
}

const strongest = <T extends string>(ladder: readonly T[], a: T | undefined, b: T | undefined) =>
  a && b ? (ladder.indexOf(a) >= ladder.indexOf(b) ? a : b) : (a ?? b)

/** Everything `known` and `shown` say about a hand together (hand features only, no names or notes) */
export function intersect(known: Spec, shown: Spec): Spec {
  const out: Spec = {}
  const hcp = narrowest(known.hcp, shown.hcp)
  const tp = narrowest(known.tp, shown.tp)
  const controls = narrowest(known.controls, shown.controls)
  if (hcp) out.hcp = hcp
  if (tp) out.tp = tp
  if (controls) out.controls = controls
  const len: Partial<Record<Suit, Range>> = {}
  const quality: Spec['quality'] = {}
  const stop: Spec['stop'] = {}
  for (const s of SUITS) {
    const l = narrowest(known.len?.[s], shown.len?.[s])
    const q = strongest(QUALITIES, known.quality?.[s], shown.quality?.[s])
    const st = strongest(STOPS, known.stop?.[s], shown.stop?.[s])
    if (l) len[s] = l
    if (q) quality[s] = q
    if (st) stop[s] = st
  }
  if (Object.keys(len).length) out.len = len
  if (Object.keys(quality).length) out.quality = quality
  if (Object.keys(stop).length) out.stop = stop
  const balanced = shown.balanced ?? known.balanced
  if (balanced !== undefined) out.balanced = balanced
  return out
}

/**
 * A call's meaning as explained for a player who has already shown `known`: each hand feature the
 * call mentions (points, controls, each suit's length, quality and stopper) taken together with
 * what the player showed, as `intersect` would; features the call does not mention are left out,
 * and names, notes and forcing stay the call's. So `intersect(known, narrow(spec, known))` is
 * `intersect(known, spec)`: what the player has shown in all does not change. The same object when
 * nothing narrows.
 *
 * With `full` (Z1, explanations only) it also carries `before`: everything else the player has
 * shown that the call does not mention (points, each suit's length, quality and stopper, shape,
 * controls, and keycards and the trump queen when `known` has them), so an explanation tells the
 * player's whole picture so far. Ranges that say nothing (0–13 cards, 0+ points) are left out. The
 * rest is as without `full`, and no rule reads `before`, so the robots read and bid the same.
 */
export function narrow(spec: Spec, known: Spec, full = false): Spec {
  const out = narrowed(spec, known)
  if (!full) return out
  const before = beforeOf(out, known)
  return before ? { ...out, before } : out
}

/** A range that tells something: not 0 up to `top` or more */
const tells = (r: Range | undefined, top: number): r is Range => !!r && (r[0] > 0 || r[1] < top)

/** What `known` says that `spec` does not mention (`narrow`'s `full`); undefined when nothing */
function beforeOf(spec: Spec, known: Spec): Spec | undefined {
  const out: Spec = {}
  for (const key of RANGES) if (!spec[key] && tells(known[key], ANY)) out[key] = known[key]
  const len: Partial<Record<Suit, Range>> = {}
  for (const s of SUITS) if (!spec.len?.[s] && tells(known.len?.[s], 13)) len[s] = known.len![s]!
  if (Object.keys(len).length) out.len = len
  for (const key of ['quality', 'stop'] as const) {
    const res: Partial<Record<Suit, string>> = {}
    for (const s of SUITS) if (known[key]?.[s] && !spec[key]?.[s]) res[s] = known[key][s]
    if (Object.keys(res).length) out[key] = res as never
  }
  if (spec.balanced === undefined && known.balanced !== undefined) out.balanced = known.balanced
  if (!spec.keycards && known.keycards) out.keycards = known.keycards
  if (spec.trumpQueen === undefined && known.trumpQueen !== undefined) out.trumpQueen = known.trumpQueen
  return Object.keys(out).length ? out : undefined
}

function narrowed(spec: Spec, known: Spec): Spec {
  if (!known.hcp && !known.tp && !known.controls && !known.len && !known.quality && !known.stop) return spec
  let out: Spec | undefined
  for (const key of RANGES) {
    const mine = spec[key]
    const theirs = known[key]
    if (!mine || !theirs) continue
    const r = narrowest(theirs, mine)!
    if (r[0] !== mine[0] || r[1] !== mine[1]) (out ??= { ...spec })[key] = r
  }
  if (spec.len && known.len) {
    let len: Spec['len']
    for (const s of SUITS) {
      const mine = spec.len[s]
      const theirs = known.len[s]
      if (!mine || !theirs) continue
      const r = narrowest(theirs, mine)!
      if (r[0] !== mine[0] || r[1] !== mine[1]) (len ??= { ...spec.len })[s] = r
    }
    if (len) (out ??= { ...spec }).len = len
  }
  for (const [key, ladder] of LADDERS) {
    const mine = spec[key]
    const theirs = known[key]
    if (!mine || !theirs) continue
    let res: Partial<Record<Suit, string>> | undefined
    for (const s of SUITS) {
      const v = mine[s] && theirs[s] ? strongest(ladder, mine[s], theirs[s]) : mine[s]
      if (v !== mine[s]) (res ??= { ...mine })[s] = v
    }
    if (res) (out ??= { ...spec })[key] = res as never
  }
  return out ?? spec
}

const RANGES = ['hcp', 'tp', 'controls'] as const
const LADDERS = [
  ['quality', QUALITIES],
  ['stop', STOPS],
] as const satisfies readonly (readonly ['quality' | 'stop', readonly string[]])[]
