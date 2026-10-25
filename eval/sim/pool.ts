import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import type { Job, JobResult, WorkerMessage } from './jobs.ts'

/**
 * A pool of worker threads, each with its own DDS (eval/sim/README.md §1). Jobs go to whichever
 * thread is free; results come back as each job finishes, in no particular order, which is why
 * every record carries its board number.
 */

/** Threads by default: the machine's logical processors but two, so the PC stays usable */
export const defaultThreads = () => Math.max(1, availableParallelism() - 2)

/** Node must strip the types of the worker's TypeScript; the same flags as `npm run sim` */
const EXEC_ARGV = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']

export class Pool {
  private readonly workers: Worker[]

  private constructor(workers: Worker[]) {
    this.workers = workers
  }

  /** Starts `threads` workers and waits until each has loaded its DDS */
  static async start(threads: number): Promise<Pool> {
    const workers = Array.from({ length: threads }, () => new Worker(new URL('./worker.ts', import.meta.url), { execArgv: EXEC_ARGV }))
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once('message', () => resolve())
            worker.once('error', reject)
          }),
      ),
    )
    return new Pool(workers)
  }

  get size() {
    return this.workers.length
  }

  /**
   * Runs the jobs over the pool. `onResults` gets each job's results as it finishes; `onProgress`
   * gets 1 for every board done, for the progress line.
   */
  run(jobs: readonly Job[], onResults: (results: JobResult[]) => void, onProgress?: (boards: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = [...jobs]
      let running = 0
      let nextId = 0
      const listeners = new Map<Worker, (message: WorkerMessage) => void>()
      const cleanup = () => {
        for (const [worker, listener] of listeners) {
          worker.off('message', listener)
          worker.off('error', fail)
        }
      }
      const fail = (error: Error) => {
        cleanup()
        reject(error)
      }
      const feed = (worker: Worker) => {
        const job = queue.shift()
        if (!job) {
          if (running === 0) {
            cleanup()
            resolve()
          }
          return
        }
        running++
        worker.postMessage({ ...job, id: nextId++ })
      }
      for (const worker of this.workers) {
        const listener = (message: WorkerMessage) => {
          if ('progress' in message) onProgress?.(message.progress)
          else if ('error' in message) fail(new Error(`worker job ${message.id} failed: ${message.error}`))
          else if ('results' in message) {
            running--
            onResults(message.results)
            feed(worker)
          }
        }
        listeners.set(worker, listener)
        worker.on('message', listener)
        worker.on('error', fail)
      }
      if (!queue.length) {
        cleanup()
        resolve()
        return
      }
      for (const worker of this.workers) feed(worker)
    })
  }

  async close() {
    await Promise.all(this.workers.map((worker) => worker.terminate()))
  }
}

/** Boards in chunks of `size`, one job each */
export function chunked(boards: readonly number[], size: number): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < boards.length; i += size) chunks.push(boards.slice(i, i + size))
  return chunks
}
