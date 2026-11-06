import { useEffect, useMemo, useState } from 'react'
import type { BoardState } from '../../shared/game.ts'
import { cardScores, DdTooComplex } from './doubleDummy.ts'
import { boardKey, forcedStep, hasSteps, positionBefore, solvedStep, tooComplexStep, type DdStep } from './ddSteps.ts'
import { solvePosition } from './useDoubleDummy.ts'

/**
 * Works through every card of a finished board in the browser (`e10-t12`), one position at a time
 * behind anything the viewer is looking at right now (`solvePosition`'s `later`), so the DDS Web
 * Worker does the solving and the page stays responsive. Stopping withdraws the position being
 * solved. A finished board is kept for the page load, in memory only: the hands do not stay on a
 * shared computer after the tab is closed.
 */

export interface BoardAnalysis {
  /** One entry per card played; undefined until it is worked out */
  steps: (DdStep | undefined)[]
  done: number
  total: number
  finished: boolean
  /** The solver itself failed (not a position too complex); the steps so far are still right */
  failed: boolean
}

const BOARDS_KEPT = 200
const kept = new Map<string, DdStep[]>()

function keep(key: string, steps: DdStep[]) {
  if (kept.size >= BOARDS_KEPT) kept.delete(kept.keys().next().value!)
  kept.set(key, steps)
}

/** Reports after each step until the board is done; the function it returns stops it */
export function analyseBoard(board: BoardState, onProgress: (analysis: BoardAnalysis) => void): () => void {
  const key = boardKey(board)
  const known = kept.get(key)
  const total = board.play.length
  if (known) {
    onProgress({ steps: known, done: total, total, finished: true, failed: false })
    return () => {}
  }
  const steps: (DdStep | undefined)[] = new Array<DdStep | undefined>(total).fill(undefined)
  let stopped = false
  let withdraw = () => {}
  const report = (done: number, failed = false) => onProgress({ steps: [...steps], done, total, finished: done === total, failed })

  const run = async () => {
    for (let index = 0; index < total; index++) {
      const position = positionBefore(board, index)
      if (!position) return report(index, true)
      if (position.legal.length === 1) steps[index] = forcedStep(board, index)
      else {
        const { result, cancel } = solvePosition(position.request, 'later')
        withdraw = cancel
        try {
          const raw = await result
          if (stopped) return
          steps[index] = solvedStep(board, index, position, cardScores(raw))
        } catch (error) {
          if (stopped) return
          if (!(error instanceof DdTooComplex)) return report(index, true)
          steps[index] = tooComplexStep(board, index)
        }
      }
      if (index === total - 1) keep(key, steps as DdStep[])
      report(index + 1)
    }
  }
  void run()
  return () => {
    stopped = true
    withdraw()
  }
}

export interface AnalysisQueue {
  /** By board; a board not reached yet has none */
  analysis: (board: BoardState) => BoardAnalysis | undefined
  /** Cards worked out and cards to work out, over all the boards */
  done: number
  total: number
  running: boolean
  stopped: boolean
  /** The solver failed on some board, so not everything was worked out */
  failed: boolean
  stop: () => void
  resume: () => void
}

/** The boards, one after another; `stop` holds until `resume`, which picks up where it left off */
export function useBoardAnalyses(boards: readonly BoardState[]): AnalysisQueue {
  const able = useMemo(() => boards.filter(hasSteps), [boards])
  const [results, setResults] = useState<ReadonlyMap<BoardState, BoardAnalysis>>(new Map())
  const [stopped, setStopped] = useState(false)

  useEffect(() => {
    if (stopped) return
    let at = 0
    let stop = () => {}
    let live = true
    const next = () => {
      const board = able[at++]
      if (!board || !live) return
      stop = analyseBoard(board, (analysis) => {
        if (!live) return
        setResults((was) => new Map(was).set(board, analysis))
        if (analysis.finished || analysis.failed) queueMicrotask(next)
      })
    }
    next()
    return () => {
      live = false
      stop()
    }
  }, [able, stopped])

  let done = 0
  let total = 0
  let settled = 0
  let failed = false
  for (const board of able) {
    const analysis = results.get(board)
    done += analysis?.done ?? 0
    total += board.play.length
    if (analysis?.finished || analysis?.failed) settled++
    if (analysis?.failed) failed = true
  }
  return {
    analysis: (board) => results.get(board),
    done,
    total,
    running: !stopped && settled < able.length,
    stopped,
    failed,
    stop: () => setStopped(true),
    resume: () => setStopped(false),
  }
}
