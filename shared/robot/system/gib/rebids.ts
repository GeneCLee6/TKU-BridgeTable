import type { Suit } from '../../../cards.ts'
import type { Hand } from '../evaluate.ts'
import type { Rule } from '../spec.ts'
import { above, bid, isMajor, UP } from './util.ts'

/**
 * Opener's rebid after a one-level response, 1o–1y (docs/BBO GIB/gib-2over1.md §2 and §3): raises
 * by strength, a new suit at the one level, 1NT, 2NT, rebidding or jumping in our suit, reverses
 * and jump shifts
 */
export function openerRebids(o: Suit, y: Suit): Rule[] {
  const rules: Rule[] = []
  const others = UP.filter((z) => z !== o && z !== y)
  // A new suit we can show at the one level, the cheapest first
  const oneLevel = others.filter((z) => above(z, y))
  // At the two level: a reverse when higher than our suit, a plain new suit when lower
  const twoLevel = others.filter((z) => !above(z, y))
  const jumpLevel = (z: Suit) => (above(z, y) ? 2 : 3)
  const fourInMajor = (h: Hand) => isMajor(y) && h.len[y] >= 4
  const own: [number, number] = [isMajor(o) ? 6 : 5, 13]

  if (isMajor(y)) rules.push({ call: bid(4, y), shows: { len: { [y]: [4, 13] }, hcp: [18, 21], notes: [{ key: 'game' }] } })
  rules.push({ call: '2N', shows: { hcp: [18, 19], balanced: true } })
  // Jump shifts: 19+ and game forcing
  for (const z of others)
    rules.push({ call: bid(jumpLevel(z), z), shows: { len: { [z]: [4, 13] }, hcp: [19, 21], forcing: 'game' }, when: (h) => !fourInMajor(h) })
  rules.push(
    { call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: [15, 17], notes: [{ key: 'invite' }] } },
    // A jump rebid promises six cards and 17–20 (GIB System Notes)
    { call: bid(3, o), shows: { len: { [o]: [6, 13] }, hcp: [17, 20] } },
  )
  // Reverses: a higher suit at the two level, 17+, the first suit longer, forcing
  for (const z of twoLevel.filter((z) => above(z, o)))
    rules.push({
      call: bid(2, z),
      shows: { name: 'reverse', len: { [z]: [4, 13], [o]: [5, 13] }, hcp: [17, 21], forcing: 'oneRound' },
      when: (h) => h.len[o] > h.len[z] && !fourInMajor(h),
    })
  // A raise of 1♦ would hide a four-card major
  rules.push({
    call: bid(2, y),
    shows: { len: { [y]: [4, 13] }, hcp: [11, 14] },
    when: (h) => isMajor(y) || (h.len.S < 4 && h.len.H < 4),
  })
  // A new suit at the one level: four or more, the cheapest first
  for (const z of oneLevel) rules.push({ call: bid(1, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 17] }, when: (h) => !fourInMajor(h) })
  rules.push({ call: '1N', shows: { hcp: [11, 14], balanced: true } })
  for (const z of twoLevel.filter((z) => !above(z, o))) rules.push({ call: bid(2, z), shows: { len: { [z]: [4, 13] }, hcp: [11, 17] } })
  rules.push({ call: bid(2, o), shows: { len: { [o]: own }, hcp: [11, 16] } })
  return rules
}
