/**
 * The Overtrick logo as data (DESIGN.md §6): `src/components/Logo.tsx` draws it inline and
 * `scripts/brand-assets.ts` makes the files in `public/` from the same shapes. No font is involved:
 * the wordmark is strokes, so it reads the same everywhere and has no text in any other language.
 *
 * The mark is a trick seen from above: four cards laid around the table, making the O of the name.
 * The gold card on top sits a step out of the ring: the one trick more than the contract asked for.
 */

/** The cards of the ring, on a 64×64 canvas */
export const MARK_CARDS = [
  { x: 44, y: 8, width: 14, height: 36 },
  { x: 22, y: 46, width: 36, height: 14 },
  { x: 6, y: 24, width: 14, height: 36 },
] as const

export const MARK_GOLD_CARD = { x: 6, y: 4, width: 36, height: 14 } as const

export const MARK_RADIUS = 3

export const WORD_WIDTH = 254
export const WORD_HEIGHT = 58
export const WORD_STROKE = 7

/** The wordmark's letters as stroke paths on a 254×58 canvas; baseline 50, x-height 22 */
export const WORD_PATHS = [
  // O
  'M23 7.5c11 0 18.5 9.3 18.5 21.2S34 50 23 50 4.500 40.600 4.500 28.700 12 7.500 23 7.500z',
  // v
  'M49 22l11.500 28L72 22',
  // e
  'M80 35.500h24c0-8-5-13.500-12-13.500-7.500 0-12.500 6-12.500 14s5 14 12.800 14c4.200 0 7.500-1.500 10.200-4.500',
  // r
  'M114 22v28M114 34c1-7.500 6-12 13-11.500',
  // t
  'M140 9v32c0 6 3 9 10 9M132 22h17',
  // r
  'M160 22v28M160 34c1-7.500 6-12 13-11.500',
  // i
  'M184 22v28M184 7.500v2',
  // c
  'M217 27.500c-2.500-3.500-6-5.500-10.500-5.500-7.500 0-12.500 6-12.500 14s5 14 12.500 14c4.500 0 8-2 10.500-5.500',
  // k
  'M227 5v45M247 22l-20 16M234 32.500L248 50',
] as const
