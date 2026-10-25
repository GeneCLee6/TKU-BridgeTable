import { useEffect, useState } from 'react'
import type { BoardState } from '../../shared/game.ts'
import {
  ddRequest,
  isCompleteDeal,
  positionKey,
  toAnalysis,
  type DdAnalysis,
  type DdPositionRaw,
  type DdPositionRequest,
  type DdRawResult,
  type DdRequest,
} from './doubleDummy.ts'

/**
 * The DD table and par of a finished board, worked out in the browser (`e6-t43`, `e4-t34`), and the
 * cards of one point of its play in double-dummy mode. Nothing is asked of the server: the board's
 * record already has all four hands, and only finished boards are analysed, so no card is shown
 * that the viewer could not already see.
 */

export type DoubleDummyState =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'done'; analysis: DdAnalysis }
  | { status: 'error' }

type Reply = { id: number; result?: unknown; error?: string }
type Message = { request: DdRequest } | { position: DdPositionRequest }

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
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

function post<T>(message: Message): Promise<T> {
  worker ??= startWorker()
  const id = nextId++
  const running = worker
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject })
    running.postMessage({ id, ...message })
  })
}

function solve(request: DdRequest): Promise<DdAnalysis> {
  const key = `${request.deal}|${request.dealer}|${request.vulnerable}`
  let analysis = cache.get(key)
  if (!analysis) {
    analysis = post<DdRawResult>({ request }).then(toAnalysis)
    // A failure is not remembered, so opening the record again tries again
    analysis.catch(() => cache.delete(key))
    cache.set(key, analysis)
  }
  return analysis
}

/*
 * Positions in double-dummy mode. Stepping through a replay asks for one position after another,
 * so only one is with the worker at a time and the ones still waiting can be withdrawn: when the
 * viewer has moved on, the position they left is never solved. Answers are kept for the page load.
 */

const POSITIONS_KEPT = 4000
const solved = new Map<string, DdPositionRaw>()
const solving = new Map<string, Promise<DdPositionRaw>>()
interface Job {
  key: string
  request: DdPositionRequest
  wanted: number
  resolve: (raw: DdPositionRaw) => void
  reject: (error: Error) => void
}
const waiting: Job[] = []
let busy = false

function pump() {
  if (busy) return
  const job = waiting.shift()
  if (!job) return
  busy = true
  post<DdPositionRaw>({ position: job.request })
    .then((raw) => {
      if (solved.size >= POSITIONS_KEPT) solved.delete(solved.keys().next().value!)
      solved.set(job.key, raw)
      job.resolve(raw)
    }, job.reject)
    .finally(() => {
      solving.delete(job.key)
      busy = false
      pump()
    })
}

/** The cards of one position; `cancel` withdraws the request if the worker has not started on it */
export function solvePosition(request: DdPositionRequest): { result: Promise<DdPositionRaw>; cancel: () => void } {
  const key = positionKey(request)
  const known = solved.get(key)
  if (known) return { result: Promise.resolve(known), cancel: () => {} }
  let result = solving.get(key)
  let job = waiting.find((j) => j.key === key)
  if (!result) {
    result = new Promise<DdPositionRaw>((resolve, reject) => {
      job = { key, request, wanted: 0, resolve, reject }
      waiting.push(job)
    })
    solving.set(key, result)
  }
  if (job) job.wanted++
  pump()
  const asked = job
  return {
    result,
    cancel: () => {
      if (!asked || --asked.wanted > 0) return
      const at = waiting.indexOf(asked)
      if (at < 0) return
      waiting.splice(at, 1)
      solving.delete(key)
    },
  }
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
