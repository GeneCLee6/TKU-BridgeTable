import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { answer, answerIs, bid, length, onlyIf, ours, pass, plus, rule, stopper } from './util.ts'

/**
 * 2♥ and 2♠ are two-suiters in the club (社長 2026-10-25; 淡江橋譜「競叫篇與技光（自然制講義）」的
 * 「何謂技光」, adapted): 2♥ is five or more hearts and five or more of another suit, 2♠ five or more
 * spades and five or more of a minor, 5–10 points (the handbook's 6–11 for a 13-point opening, moved
 * down like the weak twos and preempts). Responses follow 「技光的答叫」 and 「2NT 詢問後開叫者再叫」:
 *
 * - 2♥: pass with hearts; 2♠ pass or correct (opener passes with spades, otherwise names the minor at
 *   the three level); 2NT asks (strong): 3♣／3♦ the minor, 3♥ spades and a maximum, 3♠ spades and a
 *   minimum; 3♣／3♦ to play; 3♥ invites; 4♥ to play.
 * - 2♠: 2NT asks for the minor (not forcing to game); 3♣／3♦／3♥ a good long suit to play; 3♠
 *   invites; 4♠ to play.
 */

/** The second suit of a two-suiter: the five-card suit besides `major` (at most one fits) */
const second = (h: Hand, major: Suit, among: readonly Suit[]): Suit | undefined => among.find((s) => s !== major && h.len[s] >= 5)

/** Two-suiter openings: 2♥ hearts and any other suit, 2♠ spades and a minor */
export const twoSuiter = (h: Hand, major: Suit) => h.len[major] >= 5 && !!second(h, major, major === 'H' ? ['S', 'D', 'C'] : ['D', 'C'])

const RANGE = [5, 10] as const

/** What the openings show (`openings.ts` makes them) */
export const twoSuiterShows: Record<'2H' | '2S', Spec> = {
  '2H': { name: 'twoSuiter', len: length('H', 5), hcp: RANGE, notes: [{ key: 'withAnother' }] },
  '2S': { name: 'twoSuiter', len: { S: [5, 13], H: [0, 4] }, hcp: RANGE, notes: [{ key: 'withMinor' }] },
}

// ── 2♥: hearts and another suit ─────────────────────────────────────────────────────────────

const heartsResponses: Book = {
  after: '2H (P)',
  rules: [
    rule('4H', { len: length('H', 3), notes: [{ key: 'toPlay' }] }, (h) => h.len.H >= 3 && (h.hcp >= 14 || (h.len.H >= 4 && h.hcp <= 9))),
    rule('2N', { name: 'ask', hcp: plus(15), forcing: 'oneRound', artificial: true }, (h) => h.hcp >= 15),
    rule('3H', { len: length('H', 3), hcp: [11, 13], notes: [{ key: 'invite' }] }, (h) => h.len.H >= 3 && h.hcp >= 11),
    ...(['C', 'D'] as const).map((m) =>
      rule(bid(3, m), { len: { [m]: [6, 13], H: [0, 1] }, notes: [{ key: 'toPlay' }] }, (h) => h.len[m] >= 6 && h.len.H <= 1 && h.len[m] >= h.len[m === 'C' ? 'D' : 'C']),
    ),
    rule('2S', { name: 'passOrCorrect', len: { H: [0, 2] } }, (h) => h.len.H <= 1 || (h.len.H === 2 && h.len.S >= 4)),
    pass({ hcp: [0, 14] }),
  ],
}

/** Opener's second suit after 2♥ 2NT, and the answers that show spades */
const heartsAnswers: Rule[] = [
  rule(onlyIf(answerIs('2N'), '3C'), { len: { H: [5, 13], C: [5, 13] } }, (h) => second(h, 'H', ['C']) === 'C'),
  rule(onlyIf(answerIs('2N'), '3D'), { len: { H: [5, 13], D: [5, 13] } }, (h) => second(h, 'H', ['D']) === 'D'),
  rule(onlyIf(answerIs('2N'), '3H'), { len: { H: [5, 13], S: [5, 13] }, hcp: [8, 10], notes: [{ key: 'maximum' }], artificial: true }, (h) => h.len.S >= 5 && h.hcp >= 8),
  rule(onlyIf(answerIs('2N'), '3S'), { len: { H: [5, 13], S: [5, 13] }, hcp: [5, 7], notes: [{ key: 'minimum' }] }),
]

const heartsRebids: Book = {
  after: '2H (P) * (P)',
  only: (ctx) => answer(ctx) !== 'P',
  rules: [
    ...heartsAnswers,
    // Pass or correct: pass with spades, otherwise the minor
    rule(onlyIf(answerIs('2S'), 'P'), { len: { H: [5, 13], S: [5, 13] } }, (h) => h.len.S >= 5),
    rule(onlyIf(answerIs('2S'), '3C'), { len: { H: [5, 13], C: [5, 13] } }, (h) => h.len.C >= 5),
    rule(onlyIf(answerIs('2S'), '3D'), { len: { H: [5, 13], D: [5, 13] } }),
    // The invitation: accept with a maximum
    rule(onlyIf(answerIs('3H'), '4H'), { hcp: [8, 10], notes: [{ key: 'accept' }] }, (h) => h.hcp >= 8),
    // (after 2♠ the pass above says spades)
    rule(onlyIf((ctx) => answer(ctx) !== '2S', 'P')),
  ],
}

/** The asker places the contract once opener has shown the second suit */
const heartsPlacing: Book = {
  after: '2H (P) 2N (P) * (P)',
  rules: [
    ...(['C', 'D'] as const).flatMap((m): Rule[] => {
      const shown = (ctx: Ctx) => ours(ctx)[2] === bid(3, m)
      return [
        rule(onlyIf(shown, bid(5, m)), { len: length(m, 4), notes: [{ key: 'game' }] }, (h) => h.len[m] >= 4 && !(['S', 'D', 'C'] as const).every((s) => s === m || stopper(h, s))),
        rule(onlyIf(shown, '3N'), { notes: [{ key: 'toPlay' }] }),
      ]
    }),
    rule(onlyIf(spadesShown, '4S'), { len: length('S', 3), notes: [{ key: 'game' }] }, (h) => h.len.S >= 3),
    rule(onlyIf(spadesShown, '3N'), { notes: [{ key: 'toPlay' }] }),
    pass(),
  ],
}

function spadesShown(ctx: Ctx) {
  const shown = ours(ctx)[2]
  return shown === '3H' || shown === '3S'
}

// ── 2♠: spades and a minor ──────────────────────────────────────────────────────────────────

const spadesResponses: Book = {
  after: '2S (P)',
  rules: [
    rule('4S', { len: length('S', 3), notes: [{ key: 'toPlay' }] }, (h) => h.len.S >= 3 && (h.hcp >= 14 || (h.len.S >= 4 && h.hcp <= 9))),
    rule('2N', { name: 'minorAsk', forcing: 'oneRound', artificial: true }, (h) => h.hcp >= 15 || (h.len.S <= 1 && h.len.C >= 3 && h.len.D >= 3)),
    rule('3S', { len: length('S', 3), hcp: [11, 13], notes: [{ key: 'invite' }] }, (h) => h.len.S >= 3 && h.hcp >= 11),
    ...(['C', 'D', 'H'] as const).map((s) =>
      rule(bid(3, s), { len: { [s]: [7, 13], S: [0, 2] }, notes: [{ key: 'toPlay' }] }, (h) => h.len[s] >= 7 && h.len.S <= 2),
    ),
    pass({ hcp: [0, 14] }),
  ],
}

const spadesRebids: Book = {
  after: '2S (P) * (P)',
  only: (ctx) => answer(ctx) !== 'P',
  rules: [
    rule(onlyIf(answerIs('2N'), '3C'), { len: { S: [5, 13], C: [5, 13] } }, (h) => h.len.C >= 5),
    rule(onlyIf(answerIs('2N'), '3D'), { len: { S: [5, 13], D: [5, 13] } }),
    rule(onlyIf(answerIs('3S'), '4S'), { hcp: [8, 10], notes: [{ key: 'accept' }] }, (h) => h.hcp >= 8),
    pass(),
  ],
}

/** After 2♠ 2NT and the minor: a strong asker places the contract, a weak one passes */
const spadesPlacing: Book = {
  after: '2S (P) 2N (P) * (P)',
  rules: [
    ...(['C', 'D'] as const).flatMap((m): Rule[] => {
      const shown = (ctx: Ctx) => ours(ctx)[2] === bid(3, m)
      return [
        rule(onlyIf(shown, bid(5, m)), { len: length(m, 4), notes: [{ key: 'game' }] }, (h) => h.hcp >= 15 && h.len[m] >= 4 && !(['H', 'D', 'C'] as const).every((s) => s === m || stopper(h, s))),
        rule(onlyIf(shown, '3N'), { notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 15),
      ]
    }),
    pass(),
  ],
}

export const twoSuiters: Book[] = [heartsResponses, heartsRebids, heartsPlacing, spadesResponses, spadesRebids, spadesPlacing]
