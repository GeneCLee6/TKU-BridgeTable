import { parentPort } from 'node:worker_threads'
import { evalBoard } from '../deals.ts'
import { compareBoard } from './compare.ts'
import { biddingRecord } from './bidding.ts'
import { loadSolver } from './dds.ts'
import type { Job, JobResult, WorkerMessage } from './jobs.ts'
import { leadRecord } from './leads.ts'

/**
 * A worker thread of the pool (eval/sim/README.md §1): one DDS of its own (the WASM build is
 * single-threaded, so the cores are used by running one solver a thread), the boards it is sent
 * dealt from the seed and solved one after another, a progress message a board and the results
 * when the job is done.
 */

const port = parentPort!
const post = (message: WorkerMessage) => port.postMessage(message)
const solver = await loadSolver()

async function run(job: Job, id: number): Promise<JobResult[]> {
  const results: JobResult[] = []
  for (const boardNo of job.boards) {
    const board = evalBoard(boardNo, job.seed)
    let result: JobResult | null = null
    if (job.kind === 'tables') result = { board: boardNo, table: solver.table(board.hands) }
    else if (job.kind === 'leads') result = await leadRecord(board, job.system, solver, { samples: job.samples, seed: job.seed })
    else if (job.kind === 'bidding') result = biddingRecord(board, job.system, solver, job.options)
    else result = await compareBoard(board, job.system, solver, job.options)
    if (result) results.push(result)
    post({ id, progress: 1 })
  }
  return results
}

port.on('message', (job: Job & { id: number }) => {
  run(job, job.id)
    .then((results) => post({ id: job.id, results }))
    .catch((error: unknown) => post({ id: job.id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }))
})

post({ ready: true })
