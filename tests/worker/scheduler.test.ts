// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { AlarmQueue } from '../../worker/scheduler.ts'

let time: number
let wakes: number[]
let queue: AlarmQueue
let ran: string[]

beforeEach(() => {
  time = 1000
  wakes = []
  ran = []
  queue = new AlarmQueue(
    () => time,
    (at) => wakes.push(at),
  )
})

const job = (name: string) => async () => void ran.push(name)

describe('the alarm queue', () => {
  it('asks to be woken only when a job is earlier than the wake-up already set', () => {
    queue.add('deal:t1', 'deal', 3000, job('deal'))
    queue.add('robot:t1', 'robot', 800, job('robot'))
    queue.add('robot:t2', 'robot', 1400, job('robot 2'))
    expect(wakes).toEqual([4000, 1800])
  })

  it('keeps one job per key until it has run', async () => {
    queue.add('robot:t1', 'robot', 800, job('first'))
    queue.add('robot:t1', 'robot', 100, job('second'))
    expect(queue.pending('robot:t1')).toBe(true)
    time += 800
    await queue.runDue()
    expect(ran).toEqual(['first'])
    expect(queue.pending('robot:t1')).toBe(false)
  })

  it('runs the due jobs earliest first, then wakes again for the rest', async () => {
    queue.add('deal:t1', 'deal', 3000, job('deal'))
    queue.add('robot:t2', 'robot', 1400, job('robot 2'))
    queue.add('robot:t1', 'robot', 800, job('robot 1'))
    time += 1500
    await queue.runDue()
    expect(ran).toEqual(['robot 1', 'robot 2'])
    expect(wakes.at(-1)).toBe(4000)
  })

  it('runs a job added by a due job when it is due too (a robot answering at once)', async () => {
    queue.add('robot:t1', 'robot', 0, async () => {
      ran.push('move')
      queue.add('robot:t1', 'robot', 0, job('next move'))
    })
    await queue.runDue()
    expect(ran).toEqual(['move', 'next move'])
  })

  it('runs the due jobs side by side, so a robot that thinks holds up no other table', async () => {
    let answer: (() => void) | undefined
    queue.add('robot:t1', 'robot', 0, async () => {
      await new Promise<void>((resolve) => (answer = resolve))
      ran.push('slow table')
    })
    queue.add('robot:t2', 'robot', 0, job('other table'))
    const running = queue.runDue()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran).toEqual(['other table'])
    answer!()
    await running
    expect(ran).toEqual(['other table', 'slow table'])
  })

  it('goes on after a job fails', async () => {
    queue.add('robot:t1', 'robot', 0, async () => {
      throw new Error('boom')
    })
    queue.add('robot:t2', 'robot', 0, job('other table'))
    await queue.runDue()
    expect(ran).toEqual(['other table'])
  })

  it('does nothing when woken early, and asks again', async () => {
    queue.add('robot:t1', 'robot', 800, job('move'))
    await queue.runDue()
    expect(ran).toEqual([])
    expect(wakes).toEqual([1800, 1800])
  })
})
