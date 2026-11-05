import { dealerOf, vulnerabilityOf, type Vulnerability } from './board.ts'
import { RANKS, SUITS, type Card, type Hands, type Seat, type Suit } from './cards.ts'
import { BOARD_NO_MAX, cleanName, cleanText, replayImported, type ImportCode, type ImportedCall, type ImportedPlay, type ImportProblem } from './imports.ts'
import { formatDeal } from './pbn.ts'
import { LIMITS } from './protocol.ts'

/**
 * Reading LIN, BBO's text format, in the browser (`e4-t39`): pairs of `tag|value|`. From the format
 * as it is documented and as `lin.ts` writes it:
 *
 * - `pn` the players (South, West, North, East; eight names for the two rooms of a match),
 * - `md` the deal: the dealer's digit (1 S, 2 W, 3 N, 4 E), then the hands in the same order, the
 *   fourth often left out since the other three give it,
 * - `ah` the title (`Board 7`), `sv` the vulnerability (`o`, `n`, `e`, `b`),
 * - `mb` a call (`p`, `d`, `r`, `1C`…, `!` when alerted), `an` the explanation of the last call,
 * - `pc` a card, `mc` a claim (the declarer's tricks in all),
 * - `qx` a new board (`o7` open room, `c7` closed room); a file without it starts one at each `md`.
 *
 * Every other tag is passed over. A Handviewer link is read for its `lin=`. Whatever comes in, this
 * gives boards and problems (each naming its board) and never throws. Names stay text: they are never
 * looked up among the club's members.
 */

const ORDER: readonly Seat[] = ['S', 'W', 'N', 'E']
const VUL: Record<string, Vulnerability> = { o: 'None', '0': 'None', '-': 'None', n: 'NS', e: 'EW', b: 'Both' }
const CALLS: Record<string, string> = { P: 'P', PASS: 'P', D: 'X', X: 'X', DBL: 'X', R: 'XX', XX: 'XX', RDBL: 'XX' }

export interface LinBoard extends ImportedPlay {
  names: Record<Seat, string>
}

export interface LinParse {
  boards: LinBoard[]
  problems: ImportProblem[]
}

const decode = (text: string) => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

/** The LIN in what was pasted: as it is, or what Handviewer links and URL-encoded text carry */
function plainLin(raw: string): string {
  const text = raw.replace(/^﻿/, '')
  const links = [...text.matchAll(/[?&]lin=([^&\s"'<>]+)/g)]
  if (links.length) return links.map((m) => decode(m[1])).join('\n')
  return !text.includes('|') && /%7c/i.test(text) ? decode(text) : text
}

/** One hand's cards (`SAK3HQ2D…C…`, any case, `10` or `T`), or null */
function readHand(text: string): Card[] | null {
  const cards: Card[] = []
  let suit: Suit | null = null
  const upper = text.toUpperCase().replace(/10/g, 'T').replace(/\s/g, '')
  for (const ch of upper) {
    if ((SUITS as readonly string[]).includes(ch)) suit = ch as Suit
    else if (suit && RANKS.includes(ch)) cards.push(suit + ch)
    else return null
  }
  return cards
}

/** `md`'s value: the dealer (null when it does not say) and the deal as PBN text (null when it is no deal) */
function readDeal(value: string): { dealer: Seat | null; hands: string | null } {
  const digit = /^\s*(\d)/.exec(value)?.[1]
  const dealer = digit && digit >= '1' && digit <= '4' ? ORDER[Number(digit) - 1] : null
  const parts = value.replace(/^\s*\d/, '').split(',')
  if (parts.length < 3 || parts.length > 4) return { dealer, hands: null }
  const hands = {} as Hands
  for (const [i, part] of parts.entries()) {
    const cards = readHand(part)
    if (!cards) return { dealer, hands: null }
    hands[ORDER[i]] = cards
  }
  // The fourth hand is whatever the other three do not hold
  if (!hands.E?.length) {
    const held = new Set([...hands.S, ...hands.W, ...hands.N])
    hands.E = SUITS.flatMap((suit) => [...RANKS].map((rank) => suit + rank)).filter((card) => !held.has(card))
  }
  // Right number of cards a hand, or `formatDeal` would write a line `parseDeal` reads as another deal
  if (ORDER.some((seat) => hands[seat].length !== 13)) return { dealer, hands: null }
  return { dealer, hands: formatDeal(hands) }
}

function readCall(value: string): ImportedCall | null {
  const text = value.trim().toUpperCase()
  const alerted = text.endsWith('!')
  const word = alerted ? text.slice(0, -1) : text
  const bid = /^([1-7])(C|D|H|S|N|NT)$/.exec(word)
  const call = bid ? `${bid[1]}${bid[2][0]}` : CALLS[word]
  return call ? { call, ...(alerted && { alert: '' }) } : null
}

/** `SA`, also `AS` or `S10`, any case; null if it is no card */
function readCard(value: string): Card | null {
  const text = value.trim().toUpperCase().replace('10', 'T')
  const match = /^([SHDC])([AKQJT2-9])$/.exec(text) ?? /^([AKQJT2-9])([SHDC])$/.exec(text)
  if (!match) return null
  return (SUITS as readonly string[]).includes(match[1]) ? match[1] + match[2] : match[2] + match[1]
}

const number = (text: string) => {
  const n = Number(/\d+/.exec(text)?.[0] ?? NaN)
  return n >= 1 && n <= BOARD_NO_MAX ? n : undefined
}

/** A board while its tags are being read */
interface Draft {
  md: string
  names: string[]
  room: 'o' | 'c'
  title?: number
  qx?: number
  sv?: string
  calls: ImportedCall[]
  play: Card[]
  claim?: number
  bad?: ImportCode
}

/** Reads every board of a LIN file or paste */
export function parseLin(raw: string): LinParse {
  const out: LinParse = { boards: [], problems: [] }
  const parts = plainLin(String(raw ?? '')).split('|')
  let seen = 0
  let names: string[] = []
  let open: Draft | null = null
  // What came before the next board's `md`
  let next: Pick<Draft, 'title' | 'sv' | 'qx'> & { room: 'o' | 'c'; asked: boolean } = { room: 'o', asked: false }

  const finish = () => {
    if (!open) return
    const draft = open
    open = null
    seen++
    finishDraft(draft, seen, out)
  }

  for (let i = 0; i + 1 < parts.length; ) {
    const tag = parts[i].trim().toLowerCase()
    // Something that is no tag (a stray word): the next piece may be one
    if (!/^[a-z]{2}$/.test(tag)) {
      i++
      continue
    }
    const value = parts[i + 1]
    i += 2
    if (tag === 'qx') {
      finish()
      if (next.asked) out.problems.push({ board: next.qx ?? ++seen, code: 'importBadDeal' })
      const room = value.trim().toLowerCase()[0] === 'c' ? 'c' : 'o'
      next = { room, qx: number(value), asked: true }
    } else if (tag === 'md') {
      finish()
      open = { md: value, names, room: next.room, title: next.title, qx: next.qx, sv: next.sv, calls: [], play: [] }
      next = { room: 'o', asked: false }
    } else if (tag === 'pn') {
      names = value.split(',')
      if (open && !open.names.length) open.names = names
    } else if (tag === 'ah') {
      if (open && open.title === undefined) open.title = number(value)
      else next.title = number(value)
    } else if (tag === 'sv') {
      if (open && open.sv === undefined) open.sv = value
      else next.sv = value
    } else if (!open) continue
    else if (tag === 'mb') {
      const call = readCall(value)
      if (call) open.calls.push(call)
      else open.bad ??= 'importBadAuction'
    } else if (tag === 'an') {
      const last = open.calls.at(-1)
      if (last) last.alert = cleanText(value, LIMITS.alertMax)
    } else if (tag === 'pc') {
      const card = readCard(value)
      if (card) open.play.push(card)
      else open.bad ??= 'importBadPlay'
    } else if (tag === 'mc') {
      const tricks = /^\s*\d{1,2}\s*$/.test(value) ? Number(value) : NaN
      if (tricks >= 0 && tricks <= 13) open.claim = tricks
      else open.bad ??= 'importBadClaim'
    }
  }
  finish()
  if (next.asked) out.problems.push({ board: next.qx ?? seen + 1, code: 'importBadDeal' })
  return out
}

function finishDraft(draft: Draft, place: number, out: LinParse) {
  const boardNo = draft.title ?? draft.qx ?? Math.min(place, BOARD_NO_MAX)
  const fail = (code: ImportCode) => out.problems.push({ board: boardNo, code })
  if (draft.bad) return fail(draft.bad)
  const { dealer, hands } = readDeal(draft.md)
  if (!hands) return fail('importBadDeal')
  const given = draft.sv?.trim().toLowerCase()
  const vul = given ? VUL[given] : vulnerabilityOf(boardNo)
  if (!vul) return fail('importBadBoard')
  const play: ImportedPlay = {
    boardNo,
    dealer: dealer ?? dealerOf(boardNo),
    vul,
    hands,
    calls: draft.calls,
    play: draft.play,
    ...(draft.claim !== undefined && { claim: draft.claim }),
  }
  const replayed = replayImported(play)
  if (typeof replayed === 'string') return fail(replayed)
  // Eight names are the two rooms of a match: the closed room's are the last four
  const from = draft.room === 'c' && draft.names.length >= 8 ? 4 : 0
  const names = Object.fromEntries(ORDER.map((seat, i) => [seat, cleanName(draft.names[from + i] ?? '', seat)])) as Record<Seat, string>
  out.boards.push({ ...play, names })
}
