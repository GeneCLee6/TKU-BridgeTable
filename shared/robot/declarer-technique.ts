import { nextSeat, partnerOf, SUITS, type Card, type Seat, type Suit } from '../cards.ts'
import { suitCards } from './hand.ts'
import { byRank, value, type View } from './view.ts'

/**
 * The declarer's techniques in a suit contract (S3, ROBOT.md §3.4): ruffing in the short hand
 * before drawing trumps, setting up a long side suit by ruffing, and the elimination and
 * throw-in. Each one asks the card reading (T3, `card-reading.ts`) first: how many rounds the
 * defenders' cards last, who wins the exit card, whether the defender put on lead has a safe
 * card to return. Only the cards the declaring side sees and the reading of the other two hands.
 */

/** The defenders ruff the first round of a side suit at most this likely before we cash its master (b) */
const RUFF_RISK = 0.15
/** The short hand ruffs before trumps are drawn only with this many trumps or fewer (b) */
const SHORT_TRUMPS = 4
/** The defender behind the short hand is out of the suit by the ruff at most this likely (b) */
const OVERRUFF = 0.3
/** A long suit is set up by ruffing when the rounds it needs work out this likely (c) */
const ESTABLISH = 0.6
/** The defender meant to win the exit card holds the card that wins it this likely (a) */
const WINS_EXIT = 0.8
/** The defender on lead has no card of a suit left this likely: it cannot return that suit (a) */
const NO_RETURN = 0.85
/** No throw-in when the finesse is all but sure to work (a) */
const ONSIDE = 0.9

/** The hand with fewer trumps and the hand with more (null when they are level or one has none) */
function trumpHands(hand: Card[], partner: Card[], trump: Suit): { short: Card[]; long: Card[] } | null {
  const mine = suitCards(hand, trump).length
  const theirs = suitCards(partner, trump).length
  if (mine === theirs || !mine || !theirs) return null
  return mine < theirs ? { short: hand, long: partner } : { short: partner, long: hand }
}

/** The masters our side holds in a suit one after another from the top (not capped by length) */
export function masters(view: View, s: Suit): number {
  const ours = [...suitCards(view.ownCards(), s), ...suitCards(view.partnerCards(), s)].sort(byRank).reverse()
  let n = 0
  for (const c of ours) {
    if (!view.isMaster(c)) break
    n++
  }
  return n
}

/** The chance some defender is void in the suit now */
function voidOdds(view: View, s: Suit): number {
  const reading = view.cardReading
  if (reading.unseen.length !== 2) return 1
  return Math.min(1, reading.unseen.reduce((sum, seat) => sum + (reading.lengthOdds(seat, s)?.[0] ?? 0), 0))
}

/** The rounds the defenders' trumps last: the expected length of the longer holding */
function drawRounds(view: View, trump: Suit): number {
  const reading = view.cardReading
  const out = view.outstanding(trump)
  const p = reading.unseen.length === 2 ? reading.lengthOdds(reading.unseen[0], trump) : null
  if (!p) return Math.ceil(out / 2)
  return p.reduce((sum, w, k) => sum + w * Math.max(k, out - k), 0)
}

/**
 * The long trump hand's losers the defence can take beyond what the contract allows: in each side
 * suit the rounds of its first three cards our masters do not win, less the short hand's masters
 * beyond the long hand's length (discards), against the tricks we can still lose. Above 0, the
 * losers must go some other way: ruffed in the short hand
 */
function excessLosers(view: View, long: Card[], short: Card[], trump: Suit): number {
  let losers = 0
  let discards = 0
  for (const s of SUITS) {
    if (s === trump) continue
    const lc = suitCards(long, s)
    const sc = suitCards(short, s)
    const m = masters(view, s)
    const rounds = Math.min(lc.length, 3)
    losers += rounds - Math.min(m, rounds)
    if (sc.length > lc.length) discards += Math.max(0, Math.min(m, sc.length) - lc.length)
  }
  return losers - discards - (long.length - view.needed())
}

/**
 * The short trump hand holds a side suit of five or more, longer than the long hand's by two:
 * a suit to set up for discards once trumps are drawn, the plan the ruffs would spoil
 */
function longSuit(short: Card[], long: Card[], trump: Suit): boolean {
  return SUITS.some((s) => s !== trump && suitCards(short, s).length >= 5 && suitCards(short, s).length >= suitCards(long, s).length + 2)
}

/**
 * (b) Ruffing in the short hand before drawing trumps: the hand with fewer trumps holds a
 * singleton of a side suit where the hand with more trumps holds losers, and the long hand's
 * losers are more than the contract can lose (`excessLosers`). Drawing trumps first would take
 * the short hand's trumps (what it has left after the rounds the defenders' trumps last, from
 * the card reading, is fewer than the losers), so make it void now by cashing the suit's master
 * (the singleton itself or low to the long hand's), unless the reading says a defender may be
 * void and ruff it, or the defender behind the short hand may be out by the ruff and overruff.
 * Not with five trumps or more in the short hand, nor when it has a long suit to set up for
 * discards instead (`longSuit`). The ruffs follow (`ruffInShortHand`, `crossToRuff`).
 */
export function createVoid(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  const hands = trumpHands(hand, partner, trump)
  if (!hands || view.outstanding(trump) === 0) return null
  const { short, long } = hands
  if (excessLosers(view, long, short, trump) <= 0 || longSuit(short, long, trump)) return null
  const shortTrumps = suitCards(short, trump).length
  if (shortTrumps > SHORT_TRUMPS) return null
  const spare = shortTrumps - drawRounds(view, trump)
  // The defender playing after the short hand's ruff
  const behind = nextSeat(short === hand ? view.seat : partnerOf(view.seat))
  for (const s of SUITS) {
    if (s === trump || ruffed(s)) continue
    const sc = suitCards(short, s)
    const lc = suitCards(long, s)
    if (sc.length !== 1 || lc.length < 2 || view.outstanding(s) < 3) continue
    const top = [...sc, ...lc].sort(byRank).at(-1)!
    if (!view.isMaster(top)) continue
    // The long hand's losers once the short hand is void: its cards less the masters we hold
    const losers = lc.length - Math.min(masters(view, s), lc.length)
    if (losers < 1 || spare >= losers) continue
    if (voidOdds(view, s) > RUFF_RISK) continue
    // Not when the defender behind the short hand is likely out of the suit by the ruff (it overruffs)
    if (view.cardReading.exhausted(behind, s, 1) > OVERRUFF) continue
    if (hand.includes(top)) return top
    // Low to partner's master, when partner has no lower card it might finesse with
    if (suitCards(partner, s).slice(1).some((c) => view.higherOut(c).length === 1)) continue
    return suitCards(hand, s).at(-1)!
  }
  return null
}

/**
 * (b) The short hand is on lead, void in a suit where the long hand holds losers it still wants
 * to ruff: go over to the long hand (a side master there, low from here), rather than drawing
 * trumps from here, which would spend the trumps meant for ruffing
 */
export function crossToRuff(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  const hands = trumpHands(hand, partner, trump)
  if (!hands || hands.short !== hand || suitCards(hand, trump).length > SHORT_TRUMPS) return null
  if (excessLosers(view, partner, hand, trump) <= 0 || longSuit(hand, partner, trump)) return null
  // The defender playing after this hand's ruff
  const after = nextSeat(view.seat)
  const pending = SUITS.some((s) => {
    if (s === trump || ruffed(s) || suitCards(hand, s).length || view.outstanding(s) === 0) return false
    const lc = suitCards(partner, s)
    // A loser there, and the defender playing after this hand's ruff is not known to overruff
    return lc.some((c) => !view.isMaster(c)) && view.cardReading.exhausted(after, s) <= OVERRUFF
  })
  if (!pending) return null
  return crossTo(view, hand, partner, trump, ruffed)
}

/**
 * Over to partner: low from this hand in a side suit where partner holds the master and no lower
 * card it might finesse with (one card out above it, `declarerThird`), not a suit to be ruffed
 */
function crossTo(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean, not?: Suit): Card | null {
  for (const t of SUITS) {
    if (t === trump || t === not || ruffed(t)) continue
    const mine = suitCards(hand, t)
    const theirs = suitCards(partner, t)
    const finesse = theirs.slice(1).some((c) => view.higherOut(c).length === 1)
    if (mine.length && theirs[0] && view.isMaster(theirs[0]) && !finesse && !view.isMaster(mine.at(-1)!)) return mine.at(-1)!
  }
  return null
}

/**
 * Entries to the long hand outside the suit: side masters the short hand can lead to, as many as
 * it holds cards of that suit (not trumps: partner does not overtake a master trump led to it)
 */
function entries(view: View, long: Card[], short: Card[], s: Suit, trump: Suit, ruffed: (t: Suit) => boolean): number {
  let n = 0
  for (const t of SUITS) {
    if (t === s || t === trump || ruffed(t)) continue
    const top = suitCards(long, t).filter((c) => view.isMaster(c)).length
    n += Math.min(top, suitCards(short, t).length)
  }
  return n
}

/**
 * (c) Setting up a long side suit by ruffing, trumps drawn: the long hand of the suit holds four
 * or more, the other hand fewer and trumps. For each split of the defenders' cards (the card
 * reading's length odds), the rounds needed are the longer defender's cards; the masters win
 * the rounds the short hand follows, the short hand ruffs the rest, and the long hand needs an
 * entry after each ruff (`entries`). Taken when that works this likely (`ESTABLISH`) and gives at
 * least one long card, and at least one ruff is needed in the likeliest split. The card: cash
 * the masters (short holding first), lead low to ruff, or cross back to the long hand.
 */
export function ruffOut(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  if (view.outstanding(trump) > 0) return null
  const reading = view.cardReading
  if (reading.unseen.length !== 2) return null
  const [a] = reading.unseen
  for (const s of SUITS) {
    if (s === trump || ruffed(s)) continue
    const mine = suitCards(hand, s)
    const theirs = suitCards(partner, s)
    const long = mine.length > theirs.length ? hand : partner
    const short = long === hand ? partner : hand
    const lc = suitCards(long, s)
    const sc = suitCards(short, s)
    const shortTrumps = suitCards(short, trump).length
    const out = view.outstanding(s)
    if (lc.length < 4 || sc.length >= lc.length || !shortTrumps || !out) continue
    const odds = reading.lengthOdds(a, s)
    if (!odds) continue
    const m = masters(view, s)
    let works = 0
    let likeliest = -1
    let ruffsThen = 0
    for (let k = 0; k <= out; k++) {
      const p = odds[k] ?? 0
      if (p <= 0) continue
      const rounds = Math.max(k, out - k)
      if (p > likeliest) {
        likeliest = p
        ruffsThen = Math.max(0, rounds - Math.max(sc.length, m))
      }
      if (m < Math.min(rounds, sc.length)) continue
      const ruffs = Math.max(0, rounds - Math.max(sc.length, m))
      if (ruffs > shortTrumps || ruffs > entries(view, long, short, s, trump, ruffed)) continue
      if (lc.length - rounds < 1) continue
      works += p
    }
    if (works < ESTABLISH || ruffsThen < 1) continue
    return establishCard(view, hand, partner, long, short, s, trump, ruffed)
  }
  return null
}

function establishCard(view: View, hand: Card[], partner: Card[], long: Card[], short: Card[], s: Suit, trump: Suit, ruffed: (t: Suit) => boolean): Card | null {
  const sc = suitCards(short, s)
  const lc = suitCards(long, s)
  const mine = suitCards(hand, s)
  if (sc.length) {
    // A round won by a master while the short hand still follows: the short holding's first
    const shortMaster = sc.find((c) => view.isMaster(c))
    if (shortMaster) return short === hand ? shortMaster : (mine.at(-1) ?? null)
    if (!view.isMaster(lc[0])) return null
    return long === hand ? lc[0] : (mine.at(-1) ?? null)
  }
  // The short hand is void: masters left in the long hand go first, then low to ruff
  if (long === hand) return view.isMaster(lc[0]) ? lc[0] : lc.at(-1)!
  // On lead in the short hand: back to the long hand by a side master
  return crossTo(view, hand, partner, trump, ruffed, s)
}

/**
 * (a) Elimination and throw-in, trumps drawn and both hands still holding trumps: a key suit
 * where one hand holds a tenace (a card with one card out above it, guarded: AQ, Kx) over small
 * cards, so the defender on that hand's left leading the suit gives a trick (the tenace plays
 * last). Unless the card reading all but places the missing card where a finesse works, strip
 * the other side suits (cash their masters, ruff their losers in the hand void in them), then
 * exit with a loser the defender on the tenace's left wins (the card reading: it holds the
 * card that wins the trick), when it has no safe card to return: the exit suit and every other
 * side suit are either gone from both our hands (a return gives a ruff and discard) or gone
 * from its hand as the reading tells. Null while some step cannot be taken from this hand.
 */
export function throwIn(view: View, hand: Card[], partner: Card[], trump: Suit, ruffed: (s: Suit) => boolean): Card | null {
  if (view.outstanding(trump) > 0) return null
  const myTrumps = suitCards(hand, trump).length
  const theirTrumps = suitCards(partner, trump).length
  if (!myTrumps || !theirTrumps) return null
  const reading = view.cardReading
  if (reading.unseen.length !== 2) return null
  const key = keySuit(view, hand, partner, trump)
  if (!key) return null
  const target = key.target
  const gone = (s: Suit) => !suitCards(hand, s).length && !suitCards(partner, s).length
  const cannotReturn = (s: Suit, playing = 0) => gone(s) || reading.exhausted(target, s, playing) >= NO_RETURN
  const sides = SUITS.filter((s) => s !== trump && s !== key.suit)
  // The exit: a suit where all our cards are losers, the defender on the tenace's left wins it
  // and cannot lead it back
  const exits = sides.filter((x) => {
    const mineX = suitCards(hand, x)
    const theirsX = suitCards(partner, x)
    // A loser in both hands: one we lose anyway (a hand void with trumps would ruff it instead)
    if (!mineX.length || !theirsX.length || ruffed(x)) return false
    if ([...mineX, ...theirsX].some((c) => view.isMaster(c))) return false
    const high = [...mineX, ...theirsX].sort(byRank).at(-1)!
    const over = view.higherOut(high)
    if (!over.length) return false
    // The defender meant to win holds the card that wins the trick
    if ((reading.odds(over[0])[target] ?? 0) < WINS_EXIT) return false
    const bare = mineX.length === 1 && theirsX.length === 1
    return bare || reading.exhausted(target, x, 1) >= NO_RETURN
  })
  const x = exits[0]
  if (!x) return null
  // Strip the other side suits first: cash the masters (a suit the defender cannot return too:
  // they are tricks, and discards), then ruff the losers in the hand void in the suit. Only
  // when every suit it could return can be stripped and each hand keeps a trump for the end
  let ruffsHere = 0
  let ruffsThere = 0
  let step: Card | null = null
  let waiting = false
  for (const y of sides) {
    if (y === x || gone(y)) continue
    const mineY = suitCards(hand, y)
    const theirsY = suitCards(partner, y)
    const m = masters(view, y)
    const mineLeft = Math.max(0, mineY.length - m)
    const theirsLeft = Math.max(0, theirsY.length - m)
    const ruffable = (mineLeft > 0 && !theirsY.length) || (theirsLeft > 0 && !mineY.length)
    const free = cannotReturn(y)
    if (free && !ruffable && m === 0) continue
    if (ruffed(y)) return null
    if (mineLeft && theirsLeft && !free) return null
    if (ruffable) {
      ruffsThere += theirsY.length ? 0 : mineLeft
      ruffsHere += mineY.length ? 0 : theirsLeft
    }
    if (step) continue
    if (mineY.length && view.isMaster(mineY[0])) step = mineY[0]
    else if (mineY.length && theirsY.length && view.isMaster(theirsY[0])) step = mineY.at(-1)!
    else if (mineLeft && !theirsY.length) step = mineY.at(-1)!
    else if (m > 0 || ruffable) waiting = true
  }
  if (ruffsHere + 1 > myTrumps || ruffsThere + 1 > theirTrumps) return null
  if (step) return step
  // Partner has a suit to strip from its side: wait for the lead to get there
  if (waiting) return null
  return suitCards(hand, x).at(-1)!
}

/**
 * The key suit of a throw-in: one hand holds a card with exactly one card out above it, guarded
 * by another card, above every card of the other hand (AQ over small; Kx over small); its left
 * hand opponent leading the suit gives a trick. Not when the card reading all but places the
 * missing card on the tenace's right, where the finesse works anyway.
 */
function keySuit(view: View, hand: Card[], partner: Card[], trump: Suit): { suit: Suit; target: Seat } | null {
  const reading = view.cardReading
  for (const s of SUITS) {
    if (s === trump || view.outstanding(s) < 2) continue
    for (const [holder, seat, other] of [
      [hand, view.seat, partner],
      [partner, partnerOf(view.seat), hand],
    ] as const) {
      const hc = suitCards(holder, s)
      const oc = suitCards(other, s)
      if (hc.length < 2) continue
      const tenace = hc.find((c) => view.higherOut(c).length === 1)
      if (!tenace || (oc[0] && value(oc[0]) > value(tenace))) continue
      // A card below the tenace to keep it guarded until the last
      if (!hc.some((c) => value(c) < value(tenace)) && !hc.some((c) => view.isMaster(c))) continue
      const missing = view.higherOut(tenace)[0]
      const left = nextSeat(seat)
      const right = nextSeat(seat, 3)
      if ((reading.odds(missing)[right] ?? 0) >= ONSIDE) continue
      return { suit: s, target: left }
    }
  }
  return null
}
