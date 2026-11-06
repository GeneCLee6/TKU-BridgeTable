import { useEffect, useState } from 'react'
import type { BoardState } from '../../shared/game.ts'
import {
  DD_STEP_BUDGET_MS,
  DdTooComplex,
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

type Reply = { id: number; started?: boolean; result?: unknown; error?: string }
type Message = { request: DdRequest } | { position: DdPositionRequest }

/*
 * One worker, one job at a time. DDS cannot be interrupted, so a job is stopped by terminating the
 * worker, and the next job starts a new one. A job's clock only starts when the worker says the
 * solve has begun, so a slow download of the module is not held against a position.
 */

/** 'now': something on the screen waits for it; 'later': background work (a whole board's steps) */
export type DdPriority = 'now' | 'later'

interface Job {
  message: Message
  priority: DdPriority
  /** A position's key: what the budget applies to. The DD table has none and runs to the end. */
  key?: string
  /** Who still wants the answer; nobody left and the job is withdrawn */
  wanted: number
  resolve: (result: never) => void
  reject: (error: Error) => void
}

/** A solve nobody wants any more gets this long, since most positions finish well inside it and the worker stays loaded */
const CANCEL_GRACE_MS = 150

let worker: Worker | null = null
let nextId = 0
let running: { id: number; job: Job; started: boolean; deadline: number; timer?: ReturnType<typeof setTimeout> } | null = null
const waiting: Job[] = []
/** Over the budget once: not tried again until the page is reloaded */
const tooComplex = new Set<string>()

function stopRunning(error: Error) {
  if (!running) return
  const { job, timer } = running
  clearTimeout(timer)
  running = null
  worker?.terminate()
  worker = null
  job.reject(error)
  pump()
}

/** The running job's clock: what is left of its budget, or the short grace when nobody wants it any more */
function arm() {
  if (!running?.started) return
  const { job, deadline } = running
  clearTimeout(running.timer)
  if (job.wanted <= 0) running.timer = setTimeout(() => stopRunning(new Error('DDS cancelled')), CANCEL_GRACE_MS)
  else if (job.key) {
    const key = job.key
    running.timer = setTimeout(() => {
      tooComplex.add(key)
      stopRunning(new DdTooComplex())
    }, deadline - Date.now())
  }
}

function startWorker(): Worker {
  const started = new Worker(new URL('./dds.worker.ts', import.meta.url), { type: 'module' })
  started.addEventListener('message', (event: MessageEvent<Reply>) => {
    const { id, started: began, result, error } = event.data
    if (!running || running.id !== id) return
    if (began) {
      running.started = true
      running.deadline = Date.now() + DD_STEP_BUDGET_MS
      arm()
      return
    }
    const { job, timer } = running
    clearTimeout(timer)
    running = null
    if (result) job.resolve(result as never)
    else job.reject(new Error(error ?? 'DDS failed'))
    pump()
  })
  started.addEventListener('error', () => stopRunning(new Error('DDS worker failed')))
  return started
}

function pump() {
  if (running || !waiting.length) return
  const at = waiting.findIndex((job) => job.priority === 'now')
  const [job] = waiting.splice(Math.max(at, 0), 1)
  worker ??= startWorker()
  const id = nextId++
  running = { id, job, started: false, deadline: 0 }
  worker.postMessage({ id, ...job.message })
}

/** Each deal is solved once per page load, however often its record is opened */
const cache = new Map<string, Promise<DdAnalysis>>()

function solve(request: DdRequest): Promise<DdAnalysis> {
  const key = `${request.deal}|${request.dealer}|${request.vulnerable}`
  let analysis = cache.get(key)
  if (!analysis) {
    analysis = new Promise<DdRawResult>((resolve, reject) => {
      waiting.push({ message: { request }, priority: 'now', wanted: 1, resolve: resolve as Job['resolve'], reject })
      pump()
    }).then(toAnalysis)
    // A failure is not remembered, so opening the record again tries again
    analysis.catch(() => cache.delete(key))
    cache.set(key, analysis)
  }
  return analysis
}

/*
 * Positions in double-dummy mode and in a board's analysis. Stepping through a replay asks for one
 * position after another, so the ones still waiting can be withdrawn: when the viewer has moved on,
 * the position they left is never solved. Answers are kept for the page load, in memory.
 */

const POSITIONS_KEPT = 4000
const solved = new Map<string, DdPositionRaw>()
const solving = new Map<string, { job: Job; result: Promise<DdPositionRaw> }>()

/**
 * The cards of one position; `cancel` withdraws the request, and stops the worker if it is on it.
 * Over `DD_STEP_BUDGET_MS` the promise rejects with `DdTooComplex`: there is never a partial answer.
 */
export function solvePosition(request: DdPositionRequest, priority: DdPriority = 'now'): { result: Promise<DdPositionRaw>; cancel: () => void } {
  const key = positionKey(request)
  const known = solved.get(key)
  if (known) return { result: Promise.resolve(known), cancel: () => {} }
  if (tooComplex.has(key)) return { result: Promise.reject(new DdTooComplex()), cancel: () => {} }
  let entry = solving.get(key)
  if (!entry) {
    let created!: Job
    const result = new Promise<DdPositionRaw>((resolve, reject) => {
      created = { message: { position: request }, priority, key, wanted: 0, resolve: resolve as Job['resolve'], reject }
    }).then((raw) => {
      if (solved.size >= POSITIONS_KEPT) solved.delete(solved.keys().next().value!)
      solved.set(key, raw)
      return raw
    })
    const job = created
    const forget = () => {
      if (solving.get(key)?.job === job) solving.delete(key)
    }
    result.then(forget, forget)
    entry = { job, result }
    solving.set(key, entry)
    waiting.push(job)
  }
  const { job, result } = entry
  if (priority === 'now') job.priority = 'now'
  job.wanted++
  if (running?.job === job) arm()
  pump()
  let asked = true
  return {
    result,
    cancel: () => {
      if (!asked) return
      asked = false
      if (--job.wanted > 0) return
      const at = waiting.indexOf(job)
      if (at >= 0) {
        waiting.splice(at, 1)
        job.reject(new Error('DDS cancelled'))
      } else if (running?.job === job) arm()
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
