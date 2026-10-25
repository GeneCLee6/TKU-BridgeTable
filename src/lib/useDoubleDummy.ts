import { useEffect, useState } from 'react'
import type { BoardState } from '../../shared/game.ts'
import { ddRequest, isCompleteDeal, toAnalysis, type DdAnalysis, type DdRawResult, type DdRequest } from './doubleDummy.ts'

/**
 * The DD table and par of a finished board, worked out in the browser (`e6-t43`, `e4-t34`). Nothing
 * is asked of the server: the board's record already has all four hands, and only finished boards
 * are analysed, so no card is shown that the viewer could not already see.
 */

export type DoubleDummyState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'done'; analysis: DdAnalysis }
  | { status: 'error' }

type Reply = { id: number; result?: DdRawResult; error?: string }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (raw: DdRawResult) => void; reject: (error: Error) => void }>()
/** Each deal is solved once per page load, however often its record is opened */
const cache = new Map<string, Promise<DdAnalysis>>()

function failAll(error: Error) {
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
  worker?.terminate()
  worker = null
}

function startWorker(): Worker {
  const started = new Worker(new URL('./dds.worker.ts', import.meta.url), { type: 'module' })
  started.addEventListener('message', (event: MessageEvent<Reply>) => {
    const { id, result, error } = event.data
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (result) request.resolve(result)
    else request.reject(new Error(error ?? 'DDS failed'))
  })
  started.addEventListener('error', () => failAll(new Error('DDS worker failed')))
  return started
}

function solve(request: DdRequest): Promise<DdAnalysis> {
  const key = `${request.deal}|${request.dealer}|${request.vulnerable}`
  let analysis = cache.get(key)
  if (!analysis) {
    worker ??= startWorker()
    const id = nextId++
    const running = worker
    analysis = new Promise<DdRawResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      running.postMessage({ id, request })
    }).then(toAnalysis)
    // A failure is not remembered, so opening the record again tries again
    analysis.catch(() => cache.delete(key))
    cache.set(key, analysis)
  }
  return analysis
}

/** Whether this browser can run the solver and the board is finished with a whole deal */
export function canAnalyse(board: BoardState): boolean {
  return typeof Worker !== 'undefined' && board.phase === 'finished' && isCompleteDeal(board.hands)
}

export function useDoubleDummy(board: BoardState): DoubleDummyState {
  const able = canAnalyse(board)
  const { hands, dealer, vul } = board
  // The answer is kept with the board it belongs to, so another board shows 'loading' at once
  const [answer, setAnswer] = useState<{ hands: BoardState['hands']; state: DoubleDummyState } | null>(null)

  useEffect(() => {
    if (!able) return
    let live = true
    solve(ddRequest(hands, dealer, vul)).then(
      (analysis) => live && setAnswer({ hands, state: { status: 'done', analysis } }),
      () => live && setAnswer({ hands, state: { status: 'error' } }),
    )
    return () => {
      live = false
    }
  }, [able, hands, dealer, vul])

  if (!able) return { status: 'unavailable' }
  return answer?.hands === hands ? answer.state : { status: 'loading' }
}
