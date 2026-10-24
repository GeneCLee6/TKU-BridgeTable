import { SUITS, type Suit } from '../../cards.ts'
import { QUALITIES, STOPS, type Note, type Range, type Spec } from './spec.ts'

/**
 * GIB's two ways of putting specifications together (GIB Bid Descriptions):
 *
 * - `union`: several rules make the same call, so the call shows only what they all show, each
 *   feature at its widest ("4+ total points, 2+ cards" for a raise that is either weak with four
 *   trumps or strong with two).
 * - `intersect` (in `infer.ts`): one player made several calls, so each feature takes the
 *   narrowest range any of them showed.
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
