import { dealerOf, vulnerabilityOf, type Vulnerability } from './board.ts'
import { isSeat } from './cards.ts'
import { BOARD_NO_MAX, cleanText, IMPORT_LIMITS, type ImportedDeal, type ImportProblem } from './imports.ts'
import { formatDeal, parseDeal } from './pbn.ts'

/**
 * Reading deals from PBN in the browser (`e10-t09`, ARCHITECTURE.md §5.11): one or many games, each
 * becoming a deal of the member's own list. Only the tags are read: `Board`, `Dealer`, `Vulnerable`,
 * `Deal` and `Event` (the title); the auction and the play a game may carry are passed over. `%` lines
 * and `{…}` comments are skipped. A tag whose value is `#` takes the game before's, `##` that number
 * plus one (PBN's way of not repeating itself). Whatever comes in, this gives deals and problems (each
 * naming its board) and never throws.
 */

const VUL: Record<string, Vulnerability> = {
  none: 'None',
  love: 'None',
  '-': 'None',
  ns: 'NS',
  ew: 'EW',
  all: 'Both',
  both: 'Both',
}

/** A repeat of one of these starts the next game */
const STARTS_GAME = new Set(['event', 'board', 'deal'])

export interface PbnParse {
  deals: ImportedDeal[]
  problems: ImportProblem[]
}

const unescape = (value: string) => value.replace(/\\(["\\])/g, '$1')

export function parsePbn(raw: string): PbnParse {
  const out: PbnParse = { deals: [], problems: [] }
  const text = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\{[^}]*\}/g, ' ')
  const games: Map<string, string>[] = []
  let game = new Map<string, string>()
  let before = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('%')) continue
    const match = /^\s*\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(line)
    if (!match) continue
    const name = match[1].toLowerCase()
    if (STARTS_GAME.has(name) && game.has(name)) {
      games.push(game)
      before = game
      game = new Map()
    }
    const value = unescape(match[2]).trim()
    if (value === '#') game.set(name, before.get(name) ?? '')
    else if (value === '##') game.set(name, String(Number(before.get(name) ?? 0) + 1))
    else game.set(name, value)
  }
  if (game.size) games.push(game)
  for (const [place, tags] of games.entries()) readGame(tags, place + 1, out)
  return out
}

function readGame(tags: Map<string, string>, place: number, out: PbnParse) {
  const written = /^\d+$/.test(tags.get('board') ?? '') ? Number(tags.get('board')) : 0
  const boardNo = written >= 1 && written <= BOARD_NO_MAX ? written : Math.min(place, BOARD_NO_MAX)
  const hands = parseDeal(tags.get('deal') ?? '')
  if (!hands) return out.problems.push({ board: boardNo, code: 'importBadDeal' })
  const dealerTag = (tags.get('dealer') ?? '').toUpperCase()
  const dealer = dealerTag === '' || dealerTag === '?' ? dealerOf(boardNo) : dealerTag
  if (!isSeat(dealer)) return out.problems.push({ board: boardNo, code: 'importBadBoard' })
  const vulTag = (tags.get('vulnerable') ?? '').toLowerCase()
  const vul = vulTag === '' || vulTag === '?' ? vulnerabilityOf(boardNo) : VUL[vulTag]
  if (!vul) return out.problems.push({ board: boardNo, code: 'importBadBoard' })
  const event = cleanText(tags.get('event') ?? '', IMPORT_LIMITS.titleMax)
  out.deals.push({ boardNo, dealer, vul, hands: formatDeal(hands), ...(event && event !== '?' && { title: event }) })
}
