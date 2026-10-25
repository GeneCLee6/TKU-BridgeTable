/**
 * 淡江橋館's response tables as the robot's rules (BridgeHall E7, e7-t01 e7-t02, AC-7.1).
 *
 * `toSystemSpec` turns the `responses` blocks of a system profile's conventions into rules in the
 * shape of `shared/robot/system/spec.ts`: the auction (a `Book.after` pattern), the call, and what
 * the call shows (`Spec`), read from the meaning's words by a few strict patterns. The meaning is
 * kept word for word as the rule's explanation. A row the patterns cannot read, or whose auction
 * or call cannot be written down, goes to `unresolved` for a person to fill in (e7-t08): the
 * patterns only take what the text says outright and never add to it (TKU-BridgeBook CLAUDE.md
 * rule 1). The mapping and every pattern are listed in TKU-BridgeBook docs/SYSTEM-SPEC.md.
 *
 * The same file is in both repositories: this one is the original, and TKU-BridgeBook
 * src/lib/systemSpec.ts is a copy its parity check compares byte for byte, so change both
 * together. It imports nothing so that the copy compiles on either side; tests/engine/
 * system-spec.test.ts checks that the types fit the robot's.
 */

export type SpecSuit = 'S' | 'H' | 'D' | 'C'

/** Inclusive range; a top of `SPEC_ANY` means no upper limit (the robot's `ANY`) */
export type SpecRange = readonly [number, number]
export const SPEC_ANY = 40

/** The convention names the patterns recognise, a subset of the robot's `Convention` */
export type SpecConventionName =
  | 'stayman'
  | 'texas'
  | 'gerber'
  | 'splinter'
  | 'lebensohl'
  | 'michaels'
  | 'drury'
  | 'rkcb'
  | 'ekb'
  | 'blackwood'
  | 'negative'
  | 'responsive'

/** What a call shows, as far as the words say: a JSON-safe part of the robot's `Spec` */
export interface SpecShows {
  name?: SpecConventionName
  hcp?: SpecRange
  len?: Partial<Record<SpecSuit, SpecRange>>
  balanced?: boolean
  forcing?: 'oneRound' | 'game'
}

/** Where a row is in 淡江橋館: /c/:slug/:sectionId */
export interface SpecRef {
  slug: string
  sectionId: string
}

export interface SpecRule {
  /** `Book.after` patterns: one per way of reading the auction ("1C/D" is two) */
  after: string[]
  /** The robot's notation: '1N', '2S', 'P', 'X', 'XX' */
  call: string
  shows: SpecShows
  /** The meaning, word for word */
  text: string
  /** The row's remark, word for word */
  note?: string
  /** What is left of the meaning once the patterns have read it: absent when they read it all */
  unparsed?: string
  ref: SpecRef
}

export type UnresolvedReason =
  /** The row or its section is marked 待確認 */
  | 'pending'
  /** The table has no auction */
  | 'noAuction'
  /** The auction has no '?' (it is an example), or more than one */
  | 'noQuestion'
  /** An auction cell that cannot be written as a call: `detail` is the cell */
  | 'auctionCell'
  /** The row's call cannot be written as calls */
  | 'call'
  /** The meaning offers different hands: a numbered list, or 或／or outside brackets */
  | 'alternatives'
  /**
   * Words in brackets say something about the hand (a length, points, a shape, 或): they may
   * change what the words before them say ("3張♠，8-10(4張♠的4333，8-10)")
   */
  | 'bracketed'
  /** The patterns found no high cards, lengths or shape in the meaning */
  | 'noConditions'

export interface Unresolved {
  ref: SpecRef
  /** The row's call as the handbook writes it */
  call: string
  text: string
  reason: UnresolvedReason
  detail?: string
  /** The auction, when it could be read */
  after?: string[]
  /** What the patterns did find (a convention name, forcing) */
  shows?: SpecShows
}

export interface SystemSpec {
  profileId: string
  /** The profile's version the spec was made from */
  version: number
  rules: SpecRule[]
  unresolved: Unresolved[]
}

// ── Input: the parts of the handbook's conventions read here (`ResolvedConvention` fits) ──────────

export interface SpecInputRow {
  call: string
  meaning: string
  note?: string
  pending?: string
}

export type SpecInputCall = string | { call: string; note?: string }

export interface SpecInputBlock {
  kind: string
  auction?: { calls: SpecInputCall[] }
  rows?: SpecInputRow[]
}

export interface SpecInputSection {
  id: string
  pending?: string
  blocks?: SpecInputBlock[]
  children?: SpecInputSection[]
}

export interface SpecInputConvention {
  slug: string
  sections: SpecInputSection[]
}

// ── Calls ───────────────────────────────────────────────────────────────────────────────────

/** One handbook call ('1NT', '2D', 'P', 'PASS', 'X', 'XX') in the robot's notation, or null */
function tableCall(call: string): string | null {
  const s = call.trim().toUpperCase()
  const bid = /^([1-7])(C|D|H|S|NT)$/.exec(s)
  if (bid) return bid[1] + (bid[2] === 'NT' ? 'N' : bid[2])
  if (s === 'P' || s === 'PASS') return 'P'
  if (s === 'X' || s === 'XX') return s
  return null
}

/**
 * The calls a handbook cell stands for: "1H/S" is 1♥ or 1♠, "4D/5D" 4♦ or 5♦ (a strain without a
 * level keeps the level before it, as the handouts write it). Null when any part is not a call.
 */
export function expandCall(call: string): string[] | null {
  let level = ''
  const calls: string[] = []
  for (const part of call.split('/')) {
    const s = part.trim().toUpperCase()
    const text = level && /^(C|D|H|S|NT)$/.test(s) ? level + s : s
    level = /^([1-7])/.exec(text)?.[1] ?? level
    const one = tableCall(text)
    if (!one) return null
    calls.push(one)
  }
  return calls
}

// ── Auctions ────────────────────────────────────────────────────────────────────────────────

type AuctionResult = { after: string[] } | { reason: 'noQuestion' | 'auctionCell'; detail?: string }

const isQuestion = (call: string) => /^[?？]+$/.test(call.trim())

/**
 * A handbook auction diagram as `Book.after` patterns. The calls fill the four seats row by row and
 * '?' is the call being decided; counting back from it, every other seat is ours. Cells before the
 * opening bid are left out (the robot's auctions start there), and an empty cell where an
 * opponent calls is a pass. An empty cell of ours after the opening, a note on an empty cell and
 * '---' cannot be read and make the auction unresolved.
 */
export function auctionPatterns(calls: readonly SpecInputCall[]): AuctionResult {
  const cells = calls.map((c) => (typeof c === 'string' ? { call: c, note: undefined } : c))
  const questions = cells.flatMap((c, i) => (isQuestion(c.call) ? [i] : []))
  if (questions.length !== 1) return { reason: 'noQuestion' }
  const k = questions[0]
  const after = cells.slice(k + 1).find((c) => c.call.trim() || c.note)
  if (after) return { reason: 'auctionCell', detail: after.call || `{${after.note}}` }

  let patterns: string[][] = [[]]
  let opened = false
  for (let i = 0; i < k; i++) {
    const cell = cells[i]
    const raw = cell.call.trim()
    const ours = (k - i) % 2 === 0
    if (!raw && cell.note) return { reason: 'auctionCell', detail: `{${cell.note}}` }
    let options: string[]
    if (!raw) {
      if (!opened) continue
      if (ours) return { reason: 'auctionCell', detail: '' }
      options = ['P']
    } else {
      const expanded = expandCall(raw)
      if (!expanded) return { reason: 'auctionCell', detail: raw }
      if (!opened) {
        if (expanded.every((c) => c === 'P')) continue
        if (expanded.some((c) => !/^[1-7]/.test(c))) return { reason: 'auctionCell', detail: raw }
        opened = true
      }
      options = expanded
    }
    const tokens = options.map((c) => (ours ? c : `(${c})`))
    patterns = patterns.flatMap((p) => tokens.map((t) => [...p, t]))
  }
  return { after: patterns.map((p) => p.join(' ')) }
}

// ── Meanings ────────────────────────────────────────────────────────────────────────────────

const SUIT_OF: Record<string, SpecSuit> = {
  '♠': 'S',
  '♥': 'H',
  '♦': 'D',
  '♣': 'C',
  黑桃: 'S',
  紅心: 'H',
  方塊: 'D',
  梅花: 'C',
}
const SUIT = '(♠|♥|♦|♣|黑桃|紅心|方塊|梅花)'
const UP = '(\\+?↑|\\+|以上)'
const UNIT = '(?:點|HCP|hcp)'
const DASH = '[-~～－–]'
/** A deck has 37 high-card points at most: a bigger number is something else (55↑低花 is a shape) */
const MAX_HCP = 37

/**
 * Clauses naming another player, a condition, a maybe, a not, or a count other than high cards
 * (牌值, 控制, 墩, 關鍵張): not read at all
 */
const SKIP =
  /開叫|答叫|同伴|敵方|對方|敵叫|如|若|時|則|或|\bor\b|之後|以後|後續|再叫|可能|通常|一定|沒有|無|不|非|除|須|需|要求|避免|但|反|半|否|牌值|控制|墩|關鍵|LTC/i

/**
 * Different hands for one call: a numbered list ("1.短門♣，12-21 2.5張♠ + 4張♣"), or 或／or
 * outside brackets ("5張♥，10-12或6張♥↑，8-10"), where the parts may cross clauses
 */
const NUMBERED = /(^|\s)[1-9][.．]/
const CHOICE = /或|\bor\b/i

/** Hand words inside brackets (see `bracketed`); calls like 4♠ and remarks like 好牌 are fine */
const BRACKET_HAND = /\d\s*張|\d{4}|點|\d\s*[-~～－–]\s*\d|或|\bor\b|[↑↓+]/i
const bracketed = (text: string) =>
  (text.match(/[(（][^()（）]*[)）]?/g) ?? []).some((b) => BRACKET_HAND.test(b))

/** Where a clause ends; the handouts also use the ideographic space (U+3000) */
const CLAUSE_END = new RegExp(`[，,；;。、\\n${String.fromCharCode(0x3000)}]`)

const BALANCED_SHAPES = new Set(['4333', '4432', '5332'])

const NAMES: ReadonlyArray<[RegExp, SpecConventionName]> = [
  [/\bstayman\b/i, 'stayman'],
  [/\btexas\b/i, 'texas'],
  [/\bgerber\b/i, 'gerber'],
  [/\bsplinter\b/i, 'splinter'],
  [/\blebensohl\b/i, 'lebensohl'],
  [/\bmichaels\b/i, 'michaels'],
  [/\bdrury\b/i, 'drury'],
  [/\bRKCB\b/, 'rkcb'],
  [/\bEKB\b/, 'ekb'],
  [/\bblackwood\b/i, 'blackwood'],
  [/負性賭倍/, 'negative'],
  [/回答性賭倍/, 'responsive'],
]

interface Finding {
  key: string
  value: unknown
  span: [number, number]
}

type Extractor = [RegExp, (m: RegExpExecArray) => Array<[string, unknown]> | null]

const top = (up: string | undefined, n: number) => (up ? SPEC_ANY : n)

/** Lengths, then shortness, then high cards, in this order; the first to claim a span keeps it */
const EXTRACTORS: Extractor[] = [
  // 5張♥, 6張↑♦, 5張♣↑, 3張↑♥支持, 6張黑桃↑; not "♦/♥" (which call has which suit?) nor 1張♣↓
  [
    new RegExp(
      `(?<![\\d\\-~～])(\\d{1,2})\\s*張\\s*${UP}?\\s*的?\\s*${SUIT}\\s*${UP}?(?!\\s*(?:[/／]|↓|以下))`,
      'g',
    ),
    (m) => [[`len.${SUIT_OF[m[3]]}`, [Number(m[1]), top(m[2] ?? m[4], Number(m[1]))]]],
  ],
  // 4+♠, 6+的紅心
  [
    new RegExp(`(?<![\\d\\-~～])(\\d{1,2})\\s*\\+\\s*的?\\s*${SUIT}(?!\\s*[/／])`, 'g'),
    (m) => [[`len.${SUIT_OF[m[2]]}`, [Number(m[1]), SPEC_ANY]]],
  ],
  // 單張♦, ♦單張
  [new RegExp(`單張\\s*${SUIT}(?!\\s*[/／])`, 'g'), (m) => [[`len.${SUIT_OF[m[1]]}`, [1, 1]]]],
  [new RegExp(`(?<![/／]\\s*)${SUIT}\\s*單張`, 'g'), (m) => [[`len.${SUIT_OF[m[1]]}`, [1, 1]]]],
  // ♠ void, ♦缺門, void ♣
  [
    new RegExp(`(?<![/／]\\s*)${SUIT}\\s*(?:void|缺門)(?![A-Za-z])`, 'gi'),
    (m) => [[`len.${SUIT_OF[m[1]]}`, [0, 0]]],
  ],
  [
    new RegExp(`(?<![A-Za-z])(?:void|缺門)\\s*${SUIT}(?!\\s*[/／])`, 'gi'),
    (m) => [[`len.${SUIT_OF[m[1]]}`, [0, 0]]],
  ],
  // 15-17, 13-15 點, 5~8 HCP: rising, and not a shape (5-4, 4-4, 5-3-3-2, 5-5低花) or "11-14↑"
  [
    new RegExp(
      `(?<![\\d\\-~～.])(\\d{1,2})\\s*${UNIT}?\\s*${DASH}\\s*(\\d{1,2})\\s*${UNIT}?(?![\\d\\-~～－–])(?!\\s*(?:↑|\\+|以上|↓|以下|張|低花|高花|牌型))`,
      'g',
    ),
    (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])]
      return a < b && b <= MAX_HCP ? [['hcp', [a, b]]] : null
    },
  ],
  // 14↑, 12+↑, 13點↑, 10點以上, 19+ HCP; not a length (4+♠, 6張↑)
  [
    new RegExp(
      `(?<![\\d\\-~～.])(\\d{1,2})\\s*${UNIT}?\\s*${UP}\\s*${UNIT}?(?![\\d\\-~～])(?!\\s*的?\\s*${SUIT})(?!\\s*張)`,
      'g',
    ),
    (m) => (Number(m[1]) <= MAX_HCP ? [['hcp', [Number(m[1]), SPEC_ANY]]] : null),
  ],
  // 9點↓, 9點以下
  [
    new RegExp(`(?<![\\d\\-~～.])(\\d{1,2})\\s*${UNIT}?\\s*(?:↓|以下)(?!\\s*的?\\s*${SUIT})`, 'g'),
    (m) => (Number(m[1]) <= MAX_HCP ? [['hcp', [0, Number(m[1])]]] : null),
  ],
  // 平均牌型
  [/平均牌型/g, () => [['balanced', true]]],
  // 迫叫成局, GF; then 迫叫一圈, F一圈, a bare 迫叫
  [
    /迫叫成局|成局迫叫|迫叫(?:到|至)成局|(?<![A-Za-z])GF(?![A-Za-z])|game\s*forc(?:e|ing)/gi,
    () => [['forcing', 'game']],
  ],
  [/迫叫一圈|一圈迫叫|(?<![A-Za-z])F一圈|迫叫(?!成局|到|至)/g, () => [['forcing', 'oneRound']]],
]

/** The text with everything in brackets blanked out (same length), so it is left as it is */
function maskBrackets(text: string): string {
  let depth = 0
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(' || ch === '（') depth++
    out += depth > 0 ? '\u0001' : ch
    if ((ch === ')' || ch === '）') && depth > 0) depth--
  }
  return out
}

function shapesOf(text: string): string[] {
  const plain = text.match(/(?<!\d)\d{4}(?!\d)/g) ?? []
  const dashed = (text.match(/(?<!\d)\d-\d-\d-\d(?!\d)/g) ?? []).map((s) => s.replaceAll('-', ''))
  return [...plain, ...dashed]
}

export interface MeaningReading {
  shows: SpecShows
  /** What is left of the text: absent when the patterns read it all */
  unparsed?: string
}

/** What a meaning says outright about the hand (docs/SYSTEM-SPEC.md §3) */
export function readMeaning(text: string): MeaningReading {
  const masked = maskBrackets(text)
  const taken = new Array<boolean>(text.length).fill(false)
  const findings: Finding[] = []

  const clauses: Array<[number, number]> = []
  let start = 0
  for (let i = 0; i <= masked.length; i++) {
    if (i === masked.length || CLAUSE_END.test(masked[i])) {
      if (i > start) clauses.push([start, i])
      start = i + 1
    }
  }

  for (const [from, to] of clauses) {
    const clause = masked.slice(from, to)
    if (SKIP.test(clause)) continue
    for (const [pattern, read] of EXTRACTORS) {
      pattern.lastIndex = 0
      for (let m = pattern.exec(clause); m; m = pattern.exec(clause)) {
        const span: [number, number] = [from + m.index, from + m.index + m[0].length]
        if (taken.slice(span[0], span[1]).some(Boolean)) continue
        const values = read(m)
        if (!values) continue
        for (let i = span[0]; i < span[1]; i++) taken[i] = true
        for (const [key, value] of values) findings.push({ key, value, span })
      }
    }
    for (const [pattern, name] of NAMES) {
      const m = pattern.exec(clause)
      if (m)
        findings.push({
          key: 'name',
          value: name,
          span: [from + m.index, from + m.index + m[0].length],
        })
    }
  }

  // The club calls 6322 平均 too; the robot's `balanced` is only 4333, 4432 and 5332
  const unusualShape = shapesOf(text).some(
    (s) => !BALANCED_SHAPES.has([...s].sort().reverse().join('')),
  )

  const byKey = new Map<string, Finding[]>()
  for (const f of findings) {
    if (f.key === 'balanced' && unusualShape) continue
    byKey.set(f.key, [...(byKey.get(f.key) ?? []), f])
  }

  const shows: SpecShows = {}
  const spans: Array<[number, number]> = []
  for (const [key, list] of byKey) {
    const value = JSON.stringify(list[0].value)
    // Two different values for one thing: the text needs a person, so neither is taken
    if (list.some((f) => JSON.stringify(f.value) !== value)) continue
    spans.push(...list.map((f) => f.span))
    if (key.startsWith('len.')) {
      shows.len = { ...shows.len, [key.slice(4) as SpecSuit]: list[0].value as SpecRange }
    } else if (key === 'hcp') shows.hcp = list[0].value as SpecRange
    else if (key === 'balanced') shows.balanced = true
    else if (key === 'forcing') shows.forcing = list[0].value as 'oneRound' | 'game'
    else if (key === 'name') shows.name = list[0].value as SpecConventionName
  }

  let rest = ''
  for (let i = 0; i < text.length; i++)
    rest += spans.some(([a, b]) => i >= a && i < b) ? '，' : text[i]
  rest = rest.replace(/[，,；;。、\s]+/g, '，').replace(/^，|，$/g, '')
  const unparsed = /[\p{L}\p{N}♠♥♦♣↑↓+]/u.test(rest) ? rest : undefined
  return unparsed === undefined ? { shows } : { shows, unparsed }
}

const hasHand = (s: SpecShows) =>
  s.hcp !== undefined || s.len !== undefined || s.balanced !== undefined

// ── The conversion ──────────────────────────────────────────────────────────────────────────

/**
 * A profile's conventions (already resolved, `resolveProfile` in TKU-BridgeBook) as rules, in the
 * content's order, with everything that could not be read in `unresolved`.
 */
export function toSystemSpec(
  conventions: readonly SpecInputConvention[],
  profile: { id: string; version: number },
): SystemSpec {
  const rules: SpecRule[] = []
  const unresolved: Unresolved[] = []

  const visit = (slug: string, section: SpecInputSection) => {
    const ref: SpecRef = { slug, sectionId: section.id }
    for (const block of section.blocks ?? []) {
      if (block.kind !== 'responses' || !block.rows) continue
      const auction = block.auction ? auctionPatterns(block.auction.calls) : null
      for (const row of block.rows) {
        const base = { ref, call: row.call, text: row.meaning }
        if (row.pending !== undefined || section.pending !== undefined) {
          unresolved.push({ ...base, reason: 'pending' })
          continue
        }
        if (!auction) {
          unresolved.push({ ...base, reason: 'noAuction' })
          continue
        }
        if (!('after' in auction)) {
          const detail = auction.detail === undefined ? {} : { detail: auction.detail }
          unresolved.push({ ...base, reason: auction.reason, ...detail })
          continue
        }
        const { after } = auction
        const calls = expandCall(row.call)
        if (!calls) {
          unresolved.push({ ...base, reason: 'call', after })
          continue
        }
        if (NUMBERED.test(row.meaning) || CHOICE.test(maskBrackets(row.meaning))) {
          unresolved.push({ ...base, reason: 'alternatives', after })
          continue
        }
        if (bracketed(row.meaning)) {
          unresolved.push({ ...base, reason: 'bracketed', after })
          continue
        }
        const { shows, unparsed } = readMeaning(row.meaning)
        if (!hasHand(shows)) {
          const found = Object.keys(shows).length ? { shows } : {}
          unresolved.push({ ...base, reason: 'noConditions', after, ...found })
          continue
        }
        for (const call of calls) {
          rules.push({
            after,
            call,
            shows,
            text: row.meaning,
            ...(row.note === undefined ? {} : { note: row.note }),
            ...(unparsed === undefined ? {} : { unparsed }),
            ref,
          })
        }
      }
    }
    for (const child of section.children ?? []) visit(slug, child)
  }

  for (const convention of conventions)
    for (const section of convention.sections) visit(convention.slug, section)
  return { profileId: profile.id, version: profile.version, rules, unresolved }
}
