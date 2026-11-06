import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DD_STEP_BUDGET_MS, type DdPositionRequest } from '../../src/lib/doubleDummy.ts'

/**
 * The page's side of the DDS worker (`useDoubleDummy.ts`): one job at a time, the budget, stopping.
 * The Worker is a stand-in that says what it was asked and answers when told, since DDS cannot be
 * interrupted and all of this is about what the page does around it.
 */

class FakeWorker {
  static all: FakeWorker[] = []
  posted: { id: number; position?: DdPositionRequest }[] = []
  terminated = false
  private listeners: Record<string, ((event: { data: unknown }) => void)[]> = {}
  constructor() {
    FakeWorker.all.push(this)
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }
  postMessage(message: { id: number; position?: DdPositionRequest }) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  /** The last job: the module has loaded and DDS is on it */
  start() {
    this.send({ id: this.posted.at(-1)!.id, started: true })
  }
  answer(result: unknown = RAW) {
    this.send({ id: this.posted.at(-1)!.id, result })
  }
  private send(data: unknown) {
    for (const listener of this.listeners.message ?? []) listener({ data })
  }
}

const RAW = { suit: [0], rank: [14], equals: [0], score: [1] }

const request = (remainCards: string): DdPositionRequest => ({
  trump: 4,
  first: 0,
  currentTrickSuit: [0, 0, 0],
  currentTrickRank: [0, 0, 0],
  remainCards,
})

async function load() {
  vi.resetModules()
  return import('../../src/lib/useDoubleDummy.ts')
}

const current = () => FakeWorker.all.at(-1)!
/** Lets promises settle */
const settled = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.all = []
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the budget of a position', () => {
  it('stops the worker at the budget and answers “too complex”, never a number', async () => {
    const { solvePosition } = await load()
    const { result } = solvePosition(request('a'))
    const seen = vi.fn()
    result.catch(seen)
    current().start()
    await vi.advanceTimersByTimeAsync(DD_STEP_BUDGET_MS - 1)
    expect(seen).not.toHaveBeenCalled()
    expect(current().terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(seen.mock.calls[0][0]).toMatchObject({ name: 'DdTooComplex' })
    expect(current().terminated).toBe(true)
  })

  it('does not count the time the module takes to load', async () => {
    const { solvePosition } = await load()
    const { result } = solvePosition(request('a'))
    await vi.advanceTimersByTimeAsync(DD_STEP_BUDGET_MS * 3)
    expect(current().terminated).toBe(false)
    current().start()
    current().answer()
    await expect(result).resolves.toEqual(RAW)
  })

  it('remembers a position over the budget and does not burn the budget on it again', async () => {
    const { solvePosition } = await load()
    solvePosition(request('a')).result.catch(() => {})
    current().start()
    await vi.advanceTimersByTimeAsync(DD_STEP_BUDGET_MS)
    await expect(solvePosition(request('a')).result).rejects.toMatchObject({ name: 'DdTooComplex' })
    expect(FakeWorker.all).toHaveLength(1)
  })

  it('goes on with the next position on a new worker', async () => {
    const { solvePosition } = await load()
    solvePosition(request('a')).result.catch(() => {})
    const next = solvePosition(request('b'))
    const first = current()
    first.start()
    await vi.advanceTimersByTimeAsync(DD_STEP_BUDGET_MS)
    expect(FakeWorker.all).toHaveLength(2)
    expect(current()).not.toBe(first)
    expect(current().posted[0].position?.remainCards).toBe('b')
    current().start()
    current().answer()
    await expect(next.result).resolves.toEqual(RAW)
  })

  it('an answer inside the budget stops the clock and is kept', async () => {
    const { solvePosition } = await load()
    const { result } = solvePosition(request('a'))
    current().start()
    current().answer()
    await result
    await vi.advanceTimersByTimeAsync(DD_STEP_BUDGET_MS * 2)
    expect(current().terminated).toBe(false)
    await expect(solvePosition(request('a')).result).resolves.toEqual(RAW)
    expect(current().posted).toHaveLength(1)
  })

  it('a worker that reports a failure is a failure, not “too complex”', async () => {
    const { solvePosition } = await load()
    const { result } = solvePosition(request('a'))
    const seen = vi.fn()
    result.catch(seen)
    current().start()
    current().answer(null)
    await settled()
    expect(seen.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(seen.mock.calls[0][0]).not.toMatchObject({ name: 'DdTooComplex' })
  })
})

describe('order and stopping', () => {
  it('one at a time, and what the viewer is looking at goes ahead of background work', async () => {
    const { solvePosition } = await load()
    const a = solvePosition(request('a'), 'later')
    solvePosition(request('b'), 'later').result.catch(() => {})
    const now = solvePosition(request('now'), 'now')
    expect(current().posted.map((m) => m.position?.remainCards)).toEqual(['a'])
    current().start()
    current().answer()
    await a.result
    expect(current().posted.at(-1)?.position?.remainCards).toBe('now')
    current().start()
    current().answer()
    await now.result
    expect(current().posted.at(-1)?.position?.remainCards).toBe('b')
  })

  it('a position still waiting is never sent once withdrawn', async () => {
    const { solvePosition } = await load()
    const a = solvePosition(request('a'))
    const b = solvePosition(request('b'))
    b.result.catch(() => {})
    b.cancel()
    current().start()
    current().answer()
    await a.result
    await settled()
    expect(current().posted).toHaveLength(1)
  })

  it('stopping the position being solved stops the worker within the grace, and it can be asked again', async () => {
    const { solvePosition } = await load()
    const { result, cancel } = solvePosition(request('a'))
    result.catch(() => {})
    current().start()
    cancel()
    await vi.advanceTimersByTimeAsync(149)
    expect(current().terminated).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(current().terminated).toBe(true)
    // Not “too complex”: nothing was learned about the position
    const again = solvePosition(request('a'))
    expect(FakeWorker.all).toHaveLength(2)
    current().start()
    current().answer()
    await expect(again.result).resolves.toEqual(RAW)
  })

  it('an easy position answers inside the grace and the worker stays', async () => {
    const { solvePosition } = await load()
    const { result, cancel } = solvePosition(request('a'))
    current().start()
    cancel()
    current().answer()
    await result
    await vi.advanceTimersByTimeAsync(1000)
    expect(current().terminated).toBe(false)
  })

  it('another viewer of the same position keeps it going when one leaves', async () => {
    const { solvePosition } = await load()
    const one = solvePosition(request('a'))
    const two = solvePosition(request('a'))
    one.cancel()
    current().start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(current().terminated).toBe(false)
    current().answer()
    await expect(two.result).resolves.toEqual(RAW)
  })
})
