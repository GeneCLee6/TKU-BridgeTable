/// <reference types="vite/types/importMeta.d.ts" />
import { dealerOf, vulnerabilityOf, type Vulnerability } from '../board.ts'
import { isSeat, type Seat } from '../cards.ts'
import { parseDeal } from '../pbn.ts'
import type { PracticeProblem, PracticeSet, PracticeSetInfo, PracticeVulnerability } from './types.ts'

/**
 * The club's practice deal sets (練習牌組, `e10-t16`, ARCHITECTURE.md §5.11): every `*.json` file
 * in this folder is one set, named after the file (`competitive.json` is the set `competitive`), a
 * list of problems:
 *
 * ```json
 * [{ "id": "c01", "dealer": "N", "vulnerability": "None", "hands": "N:AKQ2.K73.9.AJ852 …",
 *    "category": "competitive", "note": "教學重點（繁中）" }]
 * ```
 *
 * The files are found with Vite's `import.meta.glob`, so a new file is listed without touching this
 * one; the Worker is built by Vite (the Cloudflare plugin) and Vitest runs it the same way. Only the
 * Worker imports this module: the hands never go into the browser's bundle, and a practice table
 * sends a problem's hands only as `worker/views.ts` allows (§4). A file that is not well formed is
 * left out and named in `PRACTICE_SET_ERRORS` (a test keeps that empty).
 */

export type { PracticeProblem, PracticeProblemFile, PracticeSet, PracticeSetInfo, PracticeVulnerability } from './types.ts'

const VULNERABILITY: Record<PracticeVulnerability, Vulnerability> = { None: 'None', NS: 'NS', EW: 'EW', All: 'Both' }

/** The first board (1–16) with this dealer and vulnerability; every pair is one of the sixteen */
export function boardNoFor(dealer: Seat, vul: Vulnerability): number {
  for (let n = 1; n <= 16; n++) if (dealerOf(n) === dealer && vulnerabilityOf(n) === vul) return n
  return 1
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max

/** Reads one set's file, or says which problem is wrong (its place, 0-based, or its id) */
export function parsePracticeSet(id: string, value: unknown): { set: PracticeSet } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) return { error: `${id}: not a list of problems` }
  const problems: PracticeProblem[] = []
  const ids = new Set<string>()
  for (const [i, entry] of value.entries()) {
    const where = `${id}[${i}]`
    if (!isObject(entry)) return { error: `${where}: not an object` }
    const { id: problemId, dealer, vulnerability, hands, category, note } = entry
    if (!text(problemId, 40) || ids.has(problemId as string)) return { error: `${where}: id` }
    if (!isSeat(dealer)) return { error: `${where}: dealer` }
    if (typeof vulnerability !== 'string' || !(vulnerability in VULNERABILITY)) return { error: `${where}: vulnerability` }
    const deal = typeof hands === 'string' ? parseDeal(hands) : null
    if (!deal) return { error: `${where}: hands` }
    if (!text(category, 40)) return { error: `${where}: category` }
    if (typeof note !== 'string' || note.length > 2000) return { error: `${where}: note` }
    ids.add(problemId as string)
    problems.push({
      id: problemId as string,
      boardNo: boardNoFor(dealer, VULNERABILITY[vulnerability as PracticeVulnerability]),
      hands: deal,
      category: category as string,
      note,
    })
  }
  return { set: { id, problems } }
}

/** Reads every set's file (by path, as `import.meta.glob` gives them): the sets by id, and what was wrong */
export function loadPracticeSets(files: Record<string, unknown>): { sets: Map<string, PracticeSet>; errors: string[] } {
  const sets = new Map<string, PracticeSet>()
  const errors: string[] = []
  for (const [path, value] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const id = /([\w-]+)\.json$/.exec(path)?.[1]
    if (!id) continue
    const parsed = parsePracticeSet(id, value)
    if ('error' in parsed) errors.push(parsed.error)
    else sets.set(id, parsed.set)
  }
  return { sets, errors }
}

const loaded = loadPracticeSets(import.meta.glob('./*.json', { eager: true, import: 'default' }))

/** The club's practice sets by id */
export const PRACTICE_SETS: ReadonlyMap<string, PracticeSet> = loaded.sets
/** Files left out for not being well formed */
export const PRACTICE_SET_ERRORS: readonly string[] = loaded.errors

/** The sets as the practice dialog lists them */
export const practiceSetInfos = (): PracticeSetInfo[] =>
  [...PRACTICE_SETS.values()].map((set) => ({
    id: set.id,
    count: set.problems.length,
    categories: [...new Set(set.problems.map((p) => p.category))],
  }))
