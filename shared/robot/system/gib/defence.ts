import type { Suit } from '../../../cards.ts'
import type { Ctx } from '../context.ts'
import type { Hand } from '../evaluate.ts'
import type { Book, Rule, Spec } from '../spec.ts'
import { above, bid, isMajor, isMinor, longest, MAJORS, other, plus, UP } from './util.ts'

/** When the opponents open, docs/BBO GIB/gib-2over1.md §7 */

const stopped = (h: Hand, s: Suit) => h.stop[s] === 'stop' || h.stop[s] === 'double'
const others = (x: Suit) => UP.filter((s) => s !== x)
/** The cheapest level for suit `y` over their bid `x` at `level` */
const levelOver = (y: Suit, x: Suit, level: number) => (above(y, x) ? level : level + 1)

/** The suit to overcall or advance in: majors first when four or more, else the longest */
function bestSuit(h: Hand, among: readonly Suit[]): Suit {
  const majors = among.filter((s) => isMajor(s) && h.len[s] >= 4)
  return majors.length ? longest(h, majors) : longest(h, among)
}

/** The two lowest suits they have not bid: Unusual 2NT shows these */
const lowestTwo = (x: Suit): [Suit, Suit] => {
  const [a, b] = others(x)
  return [a, b]
}

/** A takeout double: short in their suit with three or more in the others, or any strong hand */
function takeout(theirs: readonly Suit[], min: number, strong: number): Rule[] {
  const len: Spec['len'] = {}
  for (const s of UP) len[s] = theirs.includes(s) ? [0, 2] : [3, 13]
  return [
    { call: 'X', shows: { name: 'takeout', hcp: plus(min), len, forcing: 'oneRound' } },
    { call: 'X', shows: { name: 'takeout', hcp: plus(strong), forcing: 'oneRound' } },
  ]
}

// ── Direct and balancing overcalls of a one-level opening ─────────────────────────────────────

function overcalls(x: Suit, balancing: boolean): Rule[] {
  const rules: Rule[] = []
  const unbid = others(x)
  // Michaels: both majors over a minor, the other major and a minor over a major
  rules.push(
    isMinor(x)
      ? { call: bid(2, x), shows: { name: 'michaels', len: { H: [5, 13], S: [5, 13] }, hcp: plus(8), notes: [{ key: 'bothMajors' }], forcing: 'oneRound', artificial: true } }
      : {
          call: bid(2, x),
          shows: { name: 'michaels', len: { [other(x)]: [5, 13] }, hcp: plus(8), notes: [{ key: 'withMinor' }], forcing: 'oneRound', artificial: true },
          when: (h) => h.len.C >= 5 || h.len.D >= 5,
        },
  )
  // Unusual 2NT: the two lowest unbid suits; intermediate hands not vulnerable, better vulnerable
  const [a, b] = lowestTwo(x)
  rules.push({
    call: '2N',
    shows: (ctx: Ctx) => ({
      name: 'unusual2N',
      len: { [a]: [5, 13], [b]: [5, 13] },
      hcp: ctx.weVul ? [11, 15] : [8, 12],
      ...(isMajor(x) ? { notes: [{ key: 'bothMinors' as const }] } : {}),
      forcing: 'oneRound' as const,
      artificial: true,
    }),
  })
  rules.push({ call: '1N', shows: { hcp: balancing ? [11, 14] : [15, 18], balanced: true, stop: { [x]: 'stop' } } })
  rules.push(...takeout([x], balancing ? 9 : 12, balancing ? 15 : 17))
  if (!balancing)
    for (const y of unbid) {
      const jump = levelOver(y, x, 1) + 1
      if (jump > 3) continue
      rules.push({
        call: bid(jump, y),
        shows: { name: 'weakJumpOvercall', len: { [y]: [jump === 2 ? 6 : 7, 13] }, hcp: [3, 9] },
        when: (h) => bestSuit(h, unbid) === y,
      })
    }
  for (const y of unbid) {
    const level = levelOver(y, x, 1)
    const hcp: [number, number] = level === 1 ? (balancing ? [7, 16] : [8, 17]) : balancing ? [9, 16] : [10, 17]
    rules.push({
      call: bid(level, y),
      shows: {
        name: 'overcall',
        len: { [y]: [5, 13] },
        hcp,
        ...(level === 1 && !balancing ? { tp: [9, 19] as [number, number] } : {}),
        ...(level === 2 ? { quality: { [y]: 'rebiddable' as const } } : {}),
      },
      when: (h) => bestSuit(h, unbid) === y,
    })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** After 1x–(P)–1y: a sandwich 1NT by a passed hand, or a takeout double of the other two suits */
function sandwich(x: Suit, y: Suit): Rule[] {
  const two = UP.filter((s) => s !== x && s !== y)
  const rules: Rule[] = [
    {
      call: '1N',
      shows: { name: 'sandwich', len: { [two[0]]: [4, 13], [two[1]]: [4, 13] }, hcp: [8, 11] },
      when: (h, ctx) => ctx.passed && h.len[two[0]] + h.len[two[1]] >= 9,
    },
    { call: '1N', shows: { hcp: [15, 18], balanced: true, stop: { [x]: 'stop', [y]: 'stop' } }, when: (_, ctx) => !ctx.passed },
    { call: 'X', shows: { name: 'takeout', len: { [two[0]]: [4, 13], [two[1]]: [4, 13] }, hcp: plus(11), forcing: 'oneRound' } },
  ]
  for (const z of two) {
    const level = levelOver(z, y, 1)
    rules.push({ call: bid(level, z), shows: { name: 'overcall', len: { [z]: [5, 13] }, hcp: level === 1 ? [8, 17] : [10, 17] }, when: (h) => bestSuit(h, two) === z })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

// ── Over weak twos and preempts ──────────────────────────────────────────────────────────────

function overWeakTwo(x: Suit): Rule[] {
  const rules: Rule[] = [...takeout([x], 13, 17)]
  if (isMajor(x)) {
    // Over a weak two in a major: 4M shows a good hand with both minors, 4NT a weaker one
    rules.push(
      { call: bid(4, x), shows: { len: { C: [5, 13], D: [5, 13] }, hcp: plus(15), notes: [{ key: 'bothMinors' }], artificial: true } },
      { call: '4N', shows: { len: { C: [5, 13], D: [5, 13] }, hcp: [10, 14], notes: [{ key: 'bothMinors' }], artificial: true } },
      {
        call: bid(3, x),
        shows: { name: 'michaels', len: { [other(x)]: [5, 13] }, hcp: plus(12), notes: [{ key: 'withMinor' }], forcing: 'oneRound', artificial: true },
        when: (h) => h.len.C >= 5 || h.len.D >= 5,
      },
    )
  } else {
    rules.push({ call: '3D', shows: { name: 'michaels', len: { H: [5, 13], S: [5, 13] }, hcp: plus(12), notes: [{ key: 'bothMajors' }], forcing: 'oneRound', artificial: true } })
  }
  rules.push(
    { call: '3N', shows: { hcp: [19, 21], stop: { [x]: 'stop' }, notes: [{ key: 'toPlay' }] } },
    { call: '2N', shows: { hcp: [15, 18], balanced: true, stop: { [x]: 'stop' } } },
  )
  for (const y of others(x))
    rules.push({
      call: bid(levelOver(y, x, 2), y),
      shows: { name: 'overcall', len: { [y]: [5, 13] }, quality: { [y]: 'rebiddable' }, hcp: [12, 17] },
      when: (h) => bestSuit(h, others(x)) === y,
    })
  rules.push({ call: 'P', shows: {} })
  return rules
}

function overPreempt(x: Suit, level: 3 | 4): Rule[] {
  const rules: Rule[] = [...takeout([x], level === 3 ? 13 : 15, 18)]
  if (level === 3) {
    rules.push({ call: '3N', shows: { hcp: [16, 21], stop: { [x]: 'stop' }, notes: [{ key: 'toPlay' }] }, when: (h) => stopped(h, x) })
    for (const y of others(x))
      rules.push({
        call: bid(levelOver(y, x, 3), y),
        shows: { name: 'overcall', len: { [y]: [6, 13] }, hcp: [13, 18] },
        when: (h) => bestSuit(h, others(x)) === y && levelOver(y, x, 3) <= 4,
      })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

// ── Over 1NT: Cappelletti ────────────────────────────────────────────────────────────────────

function cappelletti(balancing: boolean): Rule[] {
  const hcp: [number, number] = balancing ? [8, 15] : [10, 15]
  const minorWith = (h: Hand) => h.len.C >= 4 || h.len.D >= 4
  return [
    { call: 'X', shows: { name: 'penalty', hcp: plus(15) } },
    { call: '2N', shows: { name: 'cappelletti', len: { C: [5, 13], D: [5, 13] }, hcp, notes: [{ key: 'bothMinors' }], artificial: true } },
    { call: '2D', shows: { name: 'cappelletti', len: { H: [4, 13], S: [4, 13] }, hcp, notes: [{ key: 'bothMajors' }], artificial: true }, when: (h) => h.len.H + h.len.S >= 9 },
    ...MAJORS.map(
      (M): Rule => ({
        call: bid(2, M),
        shows: { name: 'cappelletti', len: { [M]: [5, 13] }, hcp, notes: [{ key: 'withMinor' }] },
        when: (h) => minorWith(h) && h.len[other(M)] < 4,
      }),
    ),
    { call: '2C', shows: { name: 'cappelletti', hcp, notes: [{ key: 'oneSuiter' }], artificial: true }, when: (h) => h.shape[0] >= 6 },
    { call: 'P', shows: {} },
  ]
}

// ── Advancing partner's action ───────────────────────────────────────────────────────────────

/** Partner doubled a one-level opening for takeout */
function advanceDouble(x: Suit): Rule[] {
  const unbid = others(x)
  const rules: Rule[] = [
    { call: bid(2, x), shows: { name: 'cue', hcp: plus(12), forcing: 'oneRound', artificial: true } },
    ...MAJORS.filter((M) => M !== x).map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [5, 13] }, hcp: [10, 13], notes: [{ key: 'game' }] } })),
    { call: '3N', shows: { hcp: [13, 16], stop: { [x]: 'stop' } } },
    { call: '2N', shows: { hcp: [11, 12], stop: { [x]: 'stop' }, notes: [{ key: 'invite' }] } },
  ]
  for (const y of unbid) {
    const level = levelOver(y, x, 1)
    rules.push({
      call: bid(level + 1, y),
      shows: { len: { [y]: [4, 13] }, hcp: [9, 11], notes: [{ key: 'invite' }] },
      when: (h) => bestSuit(h, unbid) === y && level + 1 <= 3,
    })
  }
  rules.push({ call: '1N', shows: { hcp: [6, 10], stop: { [x]: 'stop' } }, when: (h) => !MAJORS.some((M) => M !== x && h.len[M] >= 4) })
  for (const y of unbid)
    rules.push({ call: bid(levelOver(y, x, 1), y), shows: { len: { [y]: [3, 13] }, hcp: [0, 8] }, when: (h) => bestSuit(h, unbid) === y })
  // Leaving the double in for penalty: a strong holding in their suit
  rules.push({ call: 'P', shows: { name: 'penalty', len: { [x]: [5, 13] }, hcp: plus(8) }, when: (h) => h.len[x] >= 5 && h.quality[x] !== null && h.quality[x] !== 'biddable' })
  return rules
}

/** Partner doubled a weak two: Lebensohl (2NT a weak relay to 3♣, three-level bids constructive) */
function advanceWeakTwoDouble(x: Suit): Rule[] {
  const unbid = others(x)
  const rules: Rule[] = [
    { call: bid(3, x), shows: { name: 'cue', hcp: plus(12), forcing: 'game', artificial: true } },
    { call: '3N', shows: { hcp: plus(10), stop: { [x]: 'stop' } }, when: (h) => stopped(h, x) },
    ...MAJORS.filter((M) => M !== x).map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [5, 13] }, hcp: plus(11), notes: [{ key: 'game' }] } })),
  ]
  for (const y of unbid) {
    const level = levelOver(y, x, 2)
    if (level === 3) rules.push({ call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: [8, 11] }, when: (h) => bestSuit(h, unbid) === y })
  }
  for (const y of unbid.filter((y) => above(y, x)))
    rules.push({ call: bid(2, y), shows: { len: { [y]: [4, 13] }, hcp: [0, 7] }, when: (h) => bestSuit(h, unbid) === y })
  rules.push({
    call: '2N',
    shows: { name: 'lebensohl', hcp: [0, 7], notes: [{ key: 'relayTo', calls: ['3C'] }], forcing: 'oneRound', artificial: true },
  })
  return rules
}

function afterWeakTwoRelay(x: Suit): Rule[] {
  return [
    ...others(x)
      .filter((y) => y !== 'C' && !above(y, x))
      .map((y): Rule => ({ call: bid(3, y), shows: { len: { [y]: [4, 13] }, hcp: [0, 7], notes: [{ key: 'signoff' }] }, when: (h) => h.len[y] >= 4 && h.len[y] >= h.len.C })),
    { call: 'P', shows: { len: { C: [4, 13] }, hcp: [0, 7], notes: [{ key: 'toPlay' }] } },
  ]
}

/** They opened, partner doubled or overcalled, and they raised: the responsive double */
function responsive(theirs: Suit, partner: Suit | null): Rule[] {
  const two = UP.filter((s) => s !== theirs && s !== partner)
  const shown = isMinor(theirs) && !partner ? MAJORS : two.slice(0, 2)
  return [
    {
      call: 'X',
      shows: { name: 'responsive', len: { [shown[0]]: [4, 13], [shown[1]]: [4, 13] }, hcp: plus(7), forcing: 'oneRound' },
      when: (h) => !partner || h.len[partner] <= 2,
    },
  ]
}

/** Partner made a responsive double: bid the cheaper of its two suits with three or more, or our own suit */
function answerResponsive(theirs: Suit, ours: Suit | null): Rule[] {
  const two = UP.filter((s) => s !== theirs && s !== ours)
  const shown = isMinor(theirs) && !ours ? MAJORS : two.slice(0, 2)
  const rules: Rule[] = shown.map(
    (s): Rule => ({ call: (ctx) => cheapestIn(ctx, s), shows: { len: { [s]: [3, 13] }, notes: [{ key: 'preference', strain: s }] }, when: (h) => h.len[s] >= 3 && h.len[s] >= h.len[shown.find((t) => t !== s)!] }),
  )
  if (ours) rules.push({ call: (ctx) => cheapestIn(ctx, ours), shows: { len: { [ours]: [6, 13] } } })
  return rules
}

const cheapestIn = (ctx: Ctx, s: Suit) => {
  for (let level = 2; level <= 4; level++) if (ctx.legal.has(bid(level, s))) return bid(level, s)
  return null
}

/** Partner overcalled in y: raises (the cue bid is a limit raise or better), notrump, a new suit */
function advanceOvercall(x: Suit, y: Suit, level: number): Rule[] {
  const rules: Rule[] = []
  const cue = bid(levelOver(x, y, level), x)
  rules.push({ call: cue, shows: { name: 'cueRaise', len: { [y]: [3, 13] }, tp: plus(10), forcing: 'oneRound', artificial: true } })
  if (isMajor(y) && level < 4)
    rules.push(
      { call: bid(4, y), shows: { len: { [y]: [4, 13] }, tp: plus(4), notes: [{ key: 'toPlay' }] }, when: (h) => h.len[y] >= 4 && h.hcp <= 9 },
      { call: bid(4, y), shows: { len: { [y]: [3, 13] }, tp: plus(13), notes: [{ key: 'game' }] } },
    )
  if (level + 2 <= 3) rules.push({ call: bid(level + 2, y), shows: { name: 'preemptiveRaise', len: { [y]: [4, 13] }, hcp: [0, 8] } })
  if (level + 1 <= 3) rules.push({ call: bid(level + 1, y), shows: { len: { [y]: [3, 13] }, tp: [6, 9] } })
  if (level === 1) {
    rules.push(
      { call: '3N', shows: { hcp: plus(15), stop: { [x]: 'stop' } } },
      { call: '2N', shows: { hcp: [12, 14], stop: { [x]: 'stop' }, notes: [{ key: 'invite' }] } },
      { call: '1N', shows: { hcp: [8, 11], stop: { [x]: 'stop' } } },
    )
  }
  for (const z of UP.filter((s) => s !== x && s !== y)) {
    const lv = above(z, y) ? level : level + 1
    if (lv <= 3) rules.push({ call: bid(lv, z), shows: { len: { [z]: [5, 13] }, hcp: plus(8) }, when: (h) => h.len[y] <= 1 && longest(h) === z })
  }
  rules.push({ call: 'P', shows: {} })
  return rules
}

/** Partner bid Michaels over 1x: pick the major (or ask for the minor) */
function advanceMichaels(x: Suit): Rule[] {
  if (isMinor(x)) {
    const pick = (h: Hand): Suit => (h.len.S > h.len.H ? 'S' : 'H')
    return [
      ...MAJORS.map((M): Rule => ({ call: bid(4, M), shows: { len: { [M]: [4, 13] }, tp: plus(11), notes: [{ key: 'game' }] }, when: (h) => pick(h) === M })),
      ...MAJORS.map((M): Rule => ({ call: bid(3, M), shows: { len: { [M]: [4, 13] }, tp: [9, 10], notes: [{ key: 'invite' }] }, when: (h) => pick(h) === M })),
      ...MAJORS.map((M): Rule => ({ call: bid(2, M), shows: { len: { [M]: [3, 13] }, notes: [{ key: 'preference', strain: M }] }, when: (h) => pick(h) === M })),
    ]
  }
  const o = other(x)
  return [
    { call: bid(4, o), shows: { len: { [o]: [3, 13] }, tp: plus(11), notes: [{ key: 'game' }] }, when: (h) => h.len[o] >= 3 },
    { call: bid(o === 'S' ? 2 : 3, o), shows: { len: { [o]: [3, 13] }, notes: [{ key: 'preference', strain: o }] }, when: (h) => h.len[o] >= 3 },
    { call: '2N', shows: { name: 'relay', artificial: true, forcing: 'oneRound' }, when: (h) => h.len[o] <= 2 },
  ]
}

/** Michaels over a major, partner asked: show the minor */
const michaelsMinor: Rule[] = [
  { call: '3D', shows: { len: { D: [5, 13] } }, when: (h) => h.len.D >= h.len.C },
  { call: '3C', shows: { len: { C: [5, 13] } } },
]

/** Partner bid Unusual 2NT over 1x: the better of the two suits shown */
function advanceUnusual(x: Suit): Rule[] {
  const [a, b] = lowestTwo(x)
  const pick = (h: Hand): Suit => (h.len[b] > h.len[a] ? b : a)
  return [a, b].flatMap((s): Rule[] => [
    { call: bid(isMinor(s) ? 5 : 4, s), shows: { len: { [s]: [4, 13] }, tp: plus(12), notes: [{ key: 'game' }] }, when: (h) => pick(h) === s },
    { call: bid(3, s), shows: { len: { [s]: [2, 13] }, notes: [{ key: 'preference', strain: s }] }, when: (h) => pick(h) === s },
  ])
}

// ── Advancing Cappelletti ────────────────────────────────────────────────────────────────────

const advanceCappelletti = {
  oneSuiter: [
    { call: '2D', shows: { name: 'relay', artificial: true, forcing: 'oneRound' } },
  ] as Rule[],
  showSuit: [
    { call: 'P', shows: { len: { D: [6, 13] } }, when: (h: Hand) => h.len.D >= 6 },
    ...(['H', 'S'] as Suit[]).map((M): Rule => ({ call: bid(2, M), shows: { len: { [M]: [6, 13] } }, when: (h) => h.len[M] >= 6 })),
    { call: '3C', shows: { len: { C: [6, 13] } } },
  ] as Rule[],
  majors: MAJORS.map((M): Rule => ({ call: bid(2, M), shows: { len: { [M]: [3, 13] }, notes: [{ key: 'preference', strain: M }] }, when: (h) => (M === 'S' ? h.len.S > h.len.H : h.len.H >= h.len.S) })),
  majorMinor: (M: Suit): Rule[] => [
    { call: 'P', shows: { len: { [M]: [2, 13] } }, when: (h) => h.len[M] >= 2 },
    { call: '2N', shows: { name: 'relay', artificial: true, forcing: 'oneRound' } },
  ],
  minors: [
    { call: '3D', shows: { len: { D: [3, 13] }, notes: [{ key: 'preference', strain: 'D' }] }, when: (h: Hand) => h.len.D > h.len.C },
    { call: '3C', shows: { len: { C: [3, 13] }, notes: [{ key: 'preference', strain: 'C' }] } },
  ] as Rule[],
}

// ── The books ─────────────────────────────────────────────────────────────────────────────────

const books: Book[] = []
for (const x of UP) {
  books.push(
    { after: `(1${x})`, rules: overcalls(x, false), more: true },
    { after: `(1${x}) P (P)`, rules: overcalls(x, true), more: true },
    { after: [`(1${x}) X (P)`, `(1${x}) P (P) X (P)`], rules: advanceDouble(x), more: true },
    // Responsive doubles up to 3♠: a raise to two or three of their suit
    { after: [`(1${x}) X (2${x})`, `(1${x}) X (3${x})`], rules: responsive(x, null), more: true },
    { after: [`(1${x}) X (2${x}) X (P)`, `(1${x}) X (3${x}) X (P)`], rules: answerResponsive(x, null), more: true },
    { after: `(1${x}) 2${x} (P)`, rules: advanceMichaels(x), more: true },
    { after: `(1${x}) 2N (P)`, rules: advanceUnusual(x), more: true },
  )
  if (isMajor(x)) books.push({ after: `(1${x}) 2${x} (P) 2N (P)`, rules: michaelsMinor, more: true })
  for (const y of others(x)) {
    const level = levelOver(y, x, 1)
    books.push({ after: `(1${x}) ${bid(level, y)} (P)`, rules: advanceOvercall(x, y, level), more: true })
    books.push({ after: [`(1${x}) ${bid(level, y)} (2${x})`, `(1${x}) ${bid(level, y)} (3${x})`], rules: responsive(x, y), more: true })
    books.push({ after: [`(1${x}) ${bid(level, y)} (2${x}) X (P)`, `(1${x}) ${bid(level, y)} (3${x}) X (P)`], rules: answerResponsive(x, y), more: true })
    if (above(y, x)) books.push({ after: `(1${x}) P (1${y})`, rules: sandwich(x, y), more: true })
  }
}
for (const x of ['D', 'H', 'S'] as Suit[])
  books.push(
    { after: `(2${x})`, rules: overWeakTwo(x), more: true },
    { after: `(2${x}) X (P)`, rules: advanceWeakTwoDouble(x), more: true },
    { after: `(2${x}) X (P) 2N (P)`, rules: [{ call: '3C', shows: { notes: [{ key: 'completes' }], artificial: true } }], more: true },
    { after: `(2${x}) X (P) 2N (P) 3C (P)`, rules: afterWeakTwoRelay(x), more: true },
  )
for (const x of UP) {
  books.push({ after: `(3${x})`, rules: overPreempt(x, 3), more: true })
  if (isMinor(x)) books.push({ after: `(4${x})`, rules: overPreempt(x, 4), more: true })
}
for (const x of MAJORS) books.push({ after: `(4${x})`, rules: overPreempt(x, 4), more: true })
books.push({ after: '(1N)', rules: cappelletti(false), more: true }, { after: '(1N) P (P)', rules: cappelletti(true), more: true })
// Advancing Cappelletti, from the direct or the balancing seat
for (const start of ['(1N)', '(1N) P (P)'])
  books.push(
    { after: `${start} 2C (P)`, rules: advanceCappelletti.oneSuiter, more: true },
    { after: `${start} 2C (P) 2D (P)`, rules: advanceCappelletti.showSuit, more: true },
    { after: `${start} 2D (P)`, rules: advanceCappelletti.majors, more: true },
    { after: `${start} 2H (P)`, rules: advanceCappelletti.majorMinor('H'), more: true },
    { after: `${start} 2S (P)`, rules: advanceCappelletti.majorMinor('S'), more: true },
    { after: [`${start} 2H (P) 2N (P)`, `${start} 2S (P) 2N (P)`], rules: michaelsMinor, more: true },
    { after: `${start} 2N (P)`, rules: advanceCappelletti.minors, more: true },
  )

export const defence: readonly Book[] = books

