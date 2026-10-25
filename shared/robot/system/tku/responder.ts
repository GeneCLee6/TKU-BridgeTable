import { isBid, levelOf, strainOf, type Call } from '../../../auction.ts'
import type { Suit } from '../../../cards.ts'
import { cheapest, type Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule } from '../spec.ts'
import { bid, isMajor, isSuit, length, MINIMUM, onlyIf, ORDER, ours, plus, rule, stopper } from './util.ts'

/**
 * Responder's rebid after one of a suit and a new suit at the one level (淡江橋譜「答叫者迫叫」
 * 「開叫者強叫」「新低花迫叫」): new minor forcing after opener's 1NT, fourth suit forcing (a game
 * force) after opener's second suit, the answers to opener's reverse (2NT asks opener to bid 3♣),
 * and simple invitations and games after opener's minimum rebid. Opener's answers to new minor
 * forcing, the fourth suit and the 2NT relay are here too. Everything later is the fallback's.
 */

/** Responder's game-forcing strength (淡江「13–15 迫叫成局」, one less with 12-point openings: 待社團確認) */
const GAME = 12
/** Responder's invitation (10–12, here 10–11 since 12 already forces) */
const INVITE = 10

// ── The auction ──────────────────────────────────────────────────────────────────────────────

/** Our side's first three calls: opening, answer, opener's rebid */
interface Start {
  /** Opener's suit */
  x: Suit
  /** Responder's suit (answered at the one level) */
  y: Suit
  /** Opener's rebid */
  rebid: Call
}

/** One of a suit, a new suit at the one level, and a rebid by opener (nobody else bid) */
function start(ctx: Ctx): Start | null {
  const [open, answer, rebid] = ours(ctx)
  if (!open || !answer || !rebid || rebid === 'P' || !isBid(rebid)) return null
  if (levelOf(open) !== 1 || levelOf(answer) !== 1) return null
  const x = strainOf(open)
  const y = strainOf(answer)
  if (!isSuit(x) || !isSuit(y) || x === y) return null
  return { x, y, rebid }
}

/** Opener's second suit: a new suit at the cheapest level */
function second(s: Start): { z: Suit; reverse: boolean } | null {
  const z = strainOf(s.rebid)
  if (!isSuit(z) || z === s.x || z === s.y) return null
  const above = ORDER.indexOf(z) > ORDER.indexOf(s.y)
  const level = levelOf(s.rebid)
  if (level !== (above ? 1 : 2)) return null
  return { z, reverse: level === 2 && ORDER.indexOf(z) > ORDER.indexOf(s.x) }
}

/** The suit nobody has bid */
const fourth = (s: Start, z: Suit): Suit => ORDER.find((w) => w !== s.x && w !== s.y && w !== z)!

/** New minor forcing: the cheapest minor not bid yet, after 1♣/1♦/1♥ – 1♥/1♠ – 1NT */
function newMinor(s: Start): Call | null {
  if (s.rebid !== '1N' || !isMajor(s.y)) return null
  const minor = (['C', 'D'] as const).find((m) => m !== s.x)
  return minor ? bid(2, minor) : null
}

/** Our side's fourth and fifth calls */
const call = (ctx: Ctx, i: number): Call | undefined => ours(ctx)[i]

// ── Responder's rebid ────────────────────────────────────────────────────────────────────────

/** `call` only when the start fits `test` */
const when = (test: (s: Start, ctx: Ctx) => boolean, made: Call | ((s: Start, ctx: Ctx) => Call | null)) =>
  onlyIf(
    (ctx) => {
      const s = start(ctx)
      return !!s && test(s, ctx)
    },
    (ctx) => (typeof made === 'function' ? made(start(ctx)!, ctx) : made),
  )

const at = (ctx: Ctx, strain: Suit | 'N', level?: number): Call | null => {
  const c = cheapest(ctx, strain)
  if (!c) return null
  return level === undefined || levelOf(c) <= level ? c : null
}
const jumpTo = (ctx: Ctx, strain: Suit, level: number): Call | null => (at(ctx, strain, level) ? bid(level, strain) : null)

/** After 1x 1M 1NT: new minor forcing, or a natural sign-off, invitation or game (「新低花迫叫」使用原則) */
function afterNotrump(): Rule[] {
  const here = (s: Start) => !!newMinor(s)
  const y = (s: Start) => s.y
  return [
    rule(when(here, (s) => bid(4, s.y)), (ctx) => ({ len: length(y(start(ctx)!), 6), hcp: plus(13), notes: [{ key: 'game' }] }), (h, ctx) => h.len[y(start(ctx)!)] >= 6 && h.hcp >= 13),
    rule(when(here, (s) => bid(3, s.y)), (ctx) => ({ len: length(y(start(ctx)!), 6), hcp: [INVITE, 12], notes: [{ key: 'invite' }] }), (h, ctx) => h.len[y(start(ctx)!)] >= 6 && h.hcp >= INVITE),
    rule(
      when(here, (s) => newMinor(s)),
      { name: 'newMinorForcing', hcp: plus(INVITE), forcing: 'oneRound', artificial: true },
      (h, ctx) => {
        const s = start(ctx)!
        return h.hcp >= INVITE && (h.len[s.y] >= 5 || (s.y === 'S' && h.len.H >= 4))
      },
    ),
    rule(when((s) => here(s) && s.y === 'S', '2H'), { len: { S: [5, 13], H: [4, 13] }, hcp: [6, 9] }, (h) => h.len.S >= 5 && h.len.H >= 4),
    rule(when(here, (s) => bid(2, s.y)), (ctx) => ({ len: length(y(start(ctx)!), 5), hcp: [6, 9], notes: [{ key: 'signoff' }] }), (h, ctx) => h.len[y(start(ctx)!)] >= 5),
    // Back to opener's minor at the two level: four cards or more, not forcing
    rule(when((s) => here(s) && !isMajor(s.x), (s) => bid(2, s.x)), (ctx) => ({ len: length(start(ctx)!.x, 4), hcp: [6, 9] }), (h, ctx) => h.len[start(ctx)!.x] >= 4 && !h.balanced),
    rule(when(here, '3N'), { hcp: plus(13), notes: [{ key: 'toPlay' }] }, (h) => h.hcp >= 13),
    rule(when(here, '2N'), { hcp: [11, 12], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 11),
    rule(when(here, 'P'), { hcp: [6, 10] }),
  ]
}

/** After opener's second suit (not a reverse): fourth suit forcing with game values, otherwise natural */
function afterSecondSuit(): Rule[] {
  const here = (s: Start) => !!second(s) && !second(s)!.reverse
  const z = (s: Start) => second(s)!.z
  const w = (s: Start) => fourth(s, z(s))
  const x = (ctx: Ctx) => start(ctx)!.x
  const zOf = (ctx: Ctx) => z(start(ctx)!)
  const wOf = (ctx: Ctx) => w(start(ctx)!)
  /** Support for opener's first suit: three for a major, four for diamonds, five for clubs (1♣ may be short) */
  const backs = (h: Hand, ctx: Ctx) => h.len[x(ctx)] >= (isMajor(x(ctx)) ? 3 : x(ctx) === 'D' ? 4 : 5)
  const fourZ = (h: Hand, ctx: Ctx) => isMajor(zOf(ctx)) && h.len[zOf(ctx)] >= 4
  const sixY = (h: Hand, ctx: Ctx) => isMajor(start(ctx)!.y) && h.len[start(ctx)!.y] >= 6
  const strong = (h: Hand) => h.hcp >= GAME
  const invite = (h: Hand) => h.hcp >= INVITE && h.hcp < GAME
  const weak = (h: Hand) => h.hcp < INVITE
  return [
    // Game values
    rule(when(here, (s) => bid(4, s.y)), (ctx) => ({ len: length(start(ctx)!.y, 6), hcp: plus(GAME), notes: [{ key: 'game' }] }), (h, ctx) => strong(h) && sixY(h, ctx)),
    rule(when(here, (s) => (isMajor(z(s)) ? bid(4, z(s)) : null)), (ctx) => ({ len: length(zOf(ctx), 4), hcp: plus(GAME), notes: [{ key: 'game' }] }), (h, ctx) => strong(h) && fourZ(h, ctx)),
    rule(when(here, (s) => (isMajor(s.x) ? bid(4, s.x) : null)), (ctx) => ({ len: length(x(ctx), 3), hcp: plus(GAME), notes: [{ key: 'game' }] }), (h, ctx) => strong(h) && backs(h, ctx)),
    rule(when(here, '3N'), (ctx) => ({ hcp: plus(GAME), stop: { [wOf(ctx)]: 'stop' } }), (h, ctx) => strong(h) && h.balanced && stopper(h, wOf(ctx))),
    rule(
      when(here, (s, ctx) => {
        const c = at(ctx, w(s))
        return c && levelOf(c) >= 2 && levelOf(c) <= 3 ? c : null
      }),
      { name: 'fourthSuit', hcp: plus(GAME), forcing: 'game', artificial: true },
      strong,
    ),
    rule(when(here, '3N'), { hcp: plus(GAME) }, strong),
    // An invitation
    rule(when(here, (s, ctx) => jumpTo(ctx, s.y, 3)), (ctx) => ({ len: length(start(ctx)!.y, 6), hcp: [INVITE, GAME - 1], notes: [{ key: 'invite' }] }), (h, ctx) => invite(h) && sixY(h, ctx)),
    rule(when(here, (s) => (isMajor(z(s)) ? bid(3, z(s)) : null)), (ctx) => ({ len: length(zOf(ctx), 4), hcp: [INVITE, GAME - 1], notes: [{ key: 'invite' }] }), (h, ctx) => invite(h) && fourZ(h, ctx)),
    rule(when(here, (s, ctx) => jumpTo(ctx, s.x, 3)), (ctx) => ({ len: length(x(ctx), 3), hcp: [INVITE, GAME - 1], notes: [{ key: 'invite' }] }), (h, ctx) => invite(h) && backs(h, ctx)),
    rule(when(here, (_, ctx) => at(ctx, 'N', 2)), (ctx) => ({ hcp: [INVITE, GAME - 1], stop: { [wOf(ctx)]: 'stop' }, notes: [{ key: 'invite' }] }), (h, ctx) => invite(h) && stopper(h, wOf(ctx))),
    rule(when(here, (_, ctx) => at(ctx, 'N', 2)), { hcp: [INVITE, GAME - 1], notes: [{ key: 'invite' }] }, invite),
    // A weak hand: raise opener's major, rebid six cards, give preference, or 1NT
    rule(when(here, (s, ctx) => (isMajor(z(s)) ? at(ctx, z(s), 2) : null)), (ctx) => ({ len: length(zOf(ctx), 4), hcp: [6, INVITE - 1] }), (h, ctx) => weak(h) && fourZ(h, ctx)),
    rule(when(here, (s, ctx) => at(ctx, s.y, 2)), (ctx) => ({ len: length(start(ctx)!.y, 6), hcp: [6, INVITE - 1] }), (h, ctx) => weak(h) && h.len[start(ctx)!.y] >= 6),
    rule(when(here, (_, ctx) => at(ctx, 'N', 1)), { hcp: [6, INVITE - 1] }, (h, ctx) => weak(h) && !backs(h, ctx)),
    rule(when(here, (s, ctx) => at(ctx, s.x, 2)), (ctx) => ({ notes: [{ key: 'preference', strain: x(ctx) }] }), (h, ctx) => h.len[x(ctx)] >= h.len[zOf(ctx)] || (levelOf(start(ctx)!.rebid) === 1 && backs(h, ctx))),
    rule(when(here, 'P'), { hcp: [6, INVITE - 1] }, weak),
  ]
}

/** After opener's reverse (「開叫者強叫」 1♦ 1♠ 2♥ ?): 2NT asks for 3♣ with a weak hand */
function afterReverse(): Rule[] {
  const here = (s: Start) => !!second(s)?.reverse
  const z = (s: Start) => second(s)!.z
  const zOf = (ctx: Ctx) => z(start(ctx)!)
  const wOf = (ctx: Ctx) => fourth(start(ctx)!, zOf(ctx))
  const x = (ctx: Ctx) => start(ctx)!.x
  const y = (ctx: Ctx) => start(ctx)!.y
  const strong = (h: Hand) => h.hcp >= INVITE
  return [
    rule(when(here, (s) => (isMajor(z(s)) ? bid(4, z(s)) : null)), (ctx) => ({ len: length(zOf(ctx), 4), hcp: [INVITE, 14], notes: [{ key: 'signoff' }] }), (h, ctx) => strong(h) && h.hcp <= 14 && h.len[zOf(ctx)] >= 4),
    rule(when(here, (s) => bid(3, s.y)), (ctx) => ({ len: length(y(ctx), 6), hcp: plus(INVITE), forcing: 'game' }), (h, ctx) => strong(h) && h.len[y(ctx)] >= 6),
    rule(when(here, (s) => bid(3, s.x)), (ctx) => ({ len: length(x(ctx), 3), hcp: plus(INVITE), forcing: 'game' }), (h, ctx) => strong(h) && h.len[x(ctx)] >= 3),
    rule(when(here, '3N'), (ctx) => ({ hcp: plus(INVITE), stop: { [wOf(ctx)]: 'stop' } }), (h, ctx) => strong(h) && stopper(h, wOf(ctx))),
    rule(
      when(here, (s, ctx) => at(ctx, fourth(s, z(s)), 3)),
      { name: 'fourthSuit', hcp: plus(INVITE), forcing: 'game', artificial: true },
      strong,
    ),
    rule(when(here, '3N'), { hcp: plus(INVITE) }, strong),
    // Weak (6–9)
    rule(when(here, (s) => bid(3, z(s))), (ctx) => ({ len: length(zOf(ctx), 4), hcp: [6, 9], notes: [{ key: 'invite' }] }), (h, ctx) => isMajor(zOf(ctx)) && h.len[zOf(ctx)] >= 4),
    rule(when(here, (s, ctx) => at(ctx, s.y, 2)), (ctx) => ({ len: length(y(ctx), 5), hcp: [6, 9] }), (h, ctx) => h.len[y(ctx)] >= 5),
    rule(when(here, '2N'), { name: 'lebensohl', hcp: [6, 9], notes: [{ key: 'relayTo', calls: ['3C'] }], artificial: true }),
  ]
}

/** After opener's minimum rebid (2 of opener's suit, 1NT without new minor forcing, the raise) */
function afterMinimum(): Rule[] {
  const kind = (s: Start): 'raise' | 'rebid' | 'notrump' | null => {
    if (s.rebid === bid(2, s.y)) return 'raise'
    if (s.rebid === bid(2, s.x)) return 'rebid'
    if (s.rebid === '1N' && !newMinor(s)) return 'notrump'
    return null
  }
  const is = (k: ReturnType<typeof kind>) => (s: Start) => kind(s) === k
  const y = (ctx: Ctx) => start(ctx)!.y
  const x = (ctx: Ctx) => start(ctx)!.x
  const backs = (h: Hand, ctx: Ctx) => h.len[x(ctx)] >= (isMajor(x(ctx)) ? 3 : 5)
  return [
    // Opener raised: game or the invitation
    rule(when(is('raise'), (s) => (isMajor(s.y) ? bid(4, s.y) : '3N')), { hcp: plus(13), notes: [{ key: 'game' }] }, (h) => h.hcp >= 13),
    rule(when(is('raise'), (s) => bid(3, s.y)), { hcp: [INVITE, 12], notes: [{ key: 'invite' }] }, (h) => h.hcp >= INVITE),
    rule(when(is('raise'), 'P')),
    // Opener rebid the suit
    rule(when(is('rebid'), (s) => (isMajor(s.y) ? bid(4, s.y) : null)), (ctx) => ({ len: length(y(ctx), 6), hcp: plus(13), notes: [{ key: 'game' }] }), (h, ctx) => h.hcp >= 13 && h.len[y(ctx)] >= 6),
    rule(when(is('rebid'), (s) => (isMajor(s.x) ? bid(4, s.x) : null)), (ctx) => ({ len: length(x(ctx), 3), hcp: plus(13), notes: [{ key: 'game' }] }), (h, ctx) => h.hcp >= 13 && backs(h, ctx)),
    rule(when(is('rebid'), '3N'), { hcp: plus(13) }, (h) => h.hcp >= 13),
    rule(when(is('rebid'), (s) => bid(3, s.y)), (ctx) => ({ len: length(y(ctx), 6), hcp: [INVITE, 12], notes: [{ key: 'invite' }] }), (h, ctx) => h.hcp >= INVITE && h.len[y(ctx)] >= 6),
    rule(when(is('rebid'), (s) => bid(3, s.x)), (ctx) => ({ len: length(x(ctx), 3), hcp: [INVITE, 12], notes: [{ key: 'invite' }] }), (h, ctx) => h.hcp >= INVITE && backs(h, ctx)),
    rule(when(is('rebid'), '2N'), { hcp: [INVITE, 12], notes: [{ key: 'invite' }] }, (h) => h.hcp >= INVITE),
    rule(when(is('rebid'), (s, ctx) => at(ctx, s.y, 2)), (ctx) => ({ len: length(y(ctx), 6), hcp: [6, 9] }), (h, ctx) => h.len[y(ctx)] >= 6),
    rule(when(is('rebid'), 'P'), { hcp: [6, 9] }),
    // Opener's 1NT (12–15) when new minor forcing does not apply (1♣ 1♦ 1NT)
    rule(when(is('notrump'), '3N'), { hcp: plus(13) }, (h) => h.hcp >= 13),
    rule(when(is('notrump'), '2N'), { hcp: [11, 12], notes: [{ key: 'invite' }] }, (h) => h.hcp >= 11),
    rule(when(is('notrump'), 'P'), { hcp: [6, 10] }),
  ]
}

const responderRebids: Book = {
  after: '* (P) * (P) * (P)',
  only: (ctx) => !!start(ctx),
  // A hand the rules leave out goes to the fallback
  more: true,
  rules: [...afterNotrump(), ...afterSecondSuit(), ...afterReverse(), ...afterMinimum()],
}

// ── Opener's answers ─────────────────────────────────────────────────────────────────────────

/** Opener after new minor forcing (「新低花迫叫」 1♣ 1♠ 1NT 2♦ ?): 4♥, three of partner's major */
const answersNewMinor: Book = {
  after: '* (P) * (P) * (P) * (P)',
  only: (ctx) => {
    const s = start(ctx)
    return !!s && !!newMinor(s) && call(ctx, 3) === newMinor(s)
  },
  rules: [
    rule(onlyIf((ctx) => start(ctx)!.y === 'S' && start(ctx)!.x !== 'H', '2H'), { len: length('H', 4) }, (h) => h.len.H >= 4),
    rule((ctx) => bid(2, start(ctx)!.y), (ctx) => ({ len: length(start(ctx)!.y, 3, 3), notes: [{ key: 'support', strain: start(ctx)!.y }] }), (h, ctx) => h.len[start(ctx)!.y] >= 3),
    rule(onlyIf((ctx) => start(ctx)!.x === 'C', '3C'), { len: length('C', 5) }, (h) => h.len.C >= 5),
    rule(onlyIf((ctx) => start(ctx)!.x === 'D', '2D'), { len: length('D', 5) }, (h) => h.len.D >= 5),
    rule('2N', { hcp: MINIMUM, notes: [{ key: 'noMajor' }] }),
  ],
}

/** Responder after opener's answer to new minor forcing: game or the invitation, in the fit or notrump */
const afterNewMinor: Book = {
  after: '* (P) * (P) * (P) * (P) * (P)',
  only: (ctx) => {
    const s = start(ctx)
    return !!s && !!newMinor(s) && call(ctx, 3) === newMinor(s)
  },
  rules: [
    ...(['H', 'S'] as const).flatMap((m): Rule[] => {
      // Opener showed three of responder's major (2♥/2♠ over 1♥/1♠), or four hearts after 1♠
      const fit = (h: Hand, ctx: Ctx) => call(ctx, 4) === bid(2, m) && (start(ctx)!.y === m ? h.len[m] >= 5 : h.len[m] >= 4)
      return [
        rule(bid(4, m), { len: length(m, 4), hcp: plus(13), notes: [{ key: 'game' }] }, (h, ctx) => fit(h, ctx) && h.hcp >= 13),
        rule(bid(3, m), { len: length(m, 4), hcp: [INVITE, 12], notes: [{ key: 'invite' }] }, (h, ctx) => fit(h, ctx)),
      ]
    }),
    rule('3N', { hcp: plus(12) }, (h, ctx) => h.hcp >= (call(ctx, 4) === '2N' || call(ctx, 4) === '3C' ? 12 : 13)),
    rule((ctx) => at(ctx, 'N', 2), { hcp: [INVITE, 12], notes: [{ key: 'invite' }] }),
    rule('P'),
  ],
}

/** After 1♣ 1♠ 1NT 2♣ (four spades and four clubs, 6–9): pass with clubs, 2♠ with three spades and three clubs */
const answersClubs: Book = {
  after: '1C (P) 1S (P) 1N (P) 2C (P)',
  rules: [rule('2S', { len: length('S', 3, 3) }, (h) => h.len.S === 3 && h.len.C <= 3), rule('P')],
}

/** Opener after the fourth suit: three of partner's major, notrump with a stopper, otherwise describe */
const answersFourthSuit: Book = {
  after: '* (P) * (P) * (P) * (P)',
  only: (ctx) => {
    const s = start(ctx)
    const z = s && second(s)
    if (!s || !z || !isBid(call(ctx, 3) ?? 'P')) return false
    return strainOf(call(ctx, 3)!) === fourth(s, z.z) && levelOf(call(ctx, 3)!) <= 3
  },
  rules: [
    rule((ctx) => cheapest(ctx, start(ctx)!.y), (ctx) => ({ len: length(start(ctx)!.y, 3), notes: [{ key: 'support', strain: start(ctx)!.y }] }), (h, ctx) => isMajor(start(ctx)!.y) && h.len[start(ctx)!.y] >= 3),
    rule((ctx) => cheapest(ctx, 'N'), (ctx) => {
      const s = start(ctx)!
      return { stop: { [fourth(s, second(s)!.z)]: 'stop' } }
    }, (h, ctx) => {
      const s = start(ctx)!
      return stopper(h, fourth(s, second(s)!.z))
    }),
    rule((ctx) => cheapest(ctx, start(ctx)!.x), (ctx) => ({ len: length(start(ctx)!.x, 6) }), (h, ctx) => h.len[start(ctx)!.x] >= 6),
    rule((ctx) => cheapest(ctx, second(start(ctx)!)!.z), (ctx) => ({ len: length(second(start(ctx)!)!.z, 5) }), (h, ctx) => h.len[second(start(ctx)!)!.z] >= 5),
    rule((ctx) => cheapest(ctx, start(ctx)!.x), (ctx) => ({ len: length(start(ctx)!.x, 5) })),
  ],
}

/** Opener after the 2NT relay over a reverse: 3♣ */
const answersRelay: Book = {
  after: '* (P) * (P) * (P) 2N (P)',
  only: (ctx) => {
    const s = start(ctx)
    return !!s && !!second(s)?.reverse
  },
  rules: [rule('3C', { name: 'lebensohl', notes: [{ key: 'completes' }] })],
}

/** Responder after the relay: pass 3♣ with clubs, otherwise opener's first suit */
const afterRelay: Book = {
  after: '* (P) * (P) * (P) 2N (P) 3C (P)',
  only: (ctx) => {
    const s = start(ctx)
    return !!s && !!second(s)?.reverse
  },
  rules: [
    rule(onlyIf((ctx) => start(ctx)!.x !== 'C', (ctx) => bid(3, start(ctx)!.x)), { notes: [{ key: 'signoff' }] }, (h, ctx) => h.len.C < 5 || h.len[start(ctx)!.x] >= 3),
    rule('P'),
  ],
}

export const responder: Book[] = [responderRebids, answersNewMinor, afterNewMinor, answersClubs, answersFourthSuit, answersRelay, afterRelay]
