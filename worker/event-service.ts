import { isOpenChallenge } from '../shared/challenge.ts'
import {
  answer,
  cancel,
  challengeTakesPart,
  deadlineOutcome,
  earlyFinish,
  nextChallengeTime,
  REMINDER_MS,
  type ChallengeChange,
} from './challenge-flow.ts'
import type { Challenge, ChallengeResult, ChallengeStore } from './challenges.ts'
import { ClubError } from './errors.ts'
import type { EventApi, Events, EventSnapshot } from './events.ts'
import { playedSeqs } from './modes.ts'
import type { Scheduler } from './scheduler.ts'

/**
 * One challenge's own rules, job and settlement (H2b, ARCHITECTURE.md §5.12): what changes when an
 * invitee answers, the creator cancels, a participant starts or finishes a board, an account is
 * deleted, and what its one job does (the reminder 12 hours before the deadline, then the
 * deadline). The transitions themselves are the pure functions of `challenge-flow.ts`; this class
 * writes them to a `ChallengeStore` and keeps the job scheduled. It never touches a Cloudflare API:
 * in the club's own object it works on the club's tables (`LocalEvents`), in an `EventObject` on
 * that object's (`EventHost`). It sends no notification and closes no table: the club does that
 * from the state it is told (`ClubService.settleChallenge`).
 */
export interface ChallengeEventDeps {
  store: ChallengeStore
  scheduler: Scheduler
  now: () => number
  /** Told after a change the challenge made on its own (its job): the club settles it */
  changed: (challenge: Challenge) => Promise<void>
  /**
   * Whether the job may still run here; false once the challenge moved to its own object (the
   * club's queue cannot take a job back)
   */
  here?: () => boolean
}

export class ChallengeEvent {
  readonly id: string
  private readonly deps: ChallengeEventDeps

  constructor(id: string, deps: ChallengeEventDeps) {
    this.id = id
    this.deps = deps
  }

  get(): Challenge | null {
    return this.deps.store.get(this.id)
  }

  private require(): Challenge {
    const challenge = this.get()
    if (!challenge) throw new ClubError('challengeGone', {}, 404)
    return challenge
  }

  private fail(code: Parameters<typeof refusal>[0]): never {
    throw refusal(code)
  }

  /** Writes a step of `challenge-flow.ts` in one transaction */
  private apply(change: ChallengeChange) {
    const { store, now } = this.deps
    store.transaction(() => {
      for (const player of change.players) store.updatePlayer(this.id, player)
      if (change.status) store.setStatus(this.id, change.status, now())
    })
  }

  /** One where every invitee answered and everyone who accepted played every board finishes now, before the deadline */
  private finishEarly() {
    const challenge = this.get()
    const change = challenge && earlyFinish(challenge)
    if (change) this.apply(change)
  }

  adopt(challenge: Challenge): Challenge {
    if (!this.get()) this.deps.store.replace(challenge)
    this.schedule()
    return this.require()
  }

  answer(userId: string, accept: boolean): Challenge {
    const step = answer(this.require(), userId, accept, this.deps.now())
    if ('error' in step) this.fail(step.error)
    this.apply(step)
    // The last decline may expire it, or leave only people who are done
    this.finishEarly()
    return this.require()
  }

  cancel(userId: string): Challenge {
    const step = cancel(this.require(), userId)
    if ('error' in step) this.fail(step.error)
    this.apply(step)
    return this.require()
  }

  /** Checked again here (the club checked its copy): open, before the deadline, and accepted */
  started(userId: string): Challenge {
    const challenge = this.require()
    const player = challenge.players.find((p) => p.userId === userId)
    if (!player) this.fail('challengeGone')
    if (!challengeTakesPart(challenge, this.deps.now())) this.fail('challengeClosed')
    if (player.status !== 'accepted') throw new ClubError('challengeNotAccepted')
    if (player.startedAt === undefined) this.deps.store.updatePlayer(this.id, { ...player, startedAt: this.deps.now() })
    return this.require()
  }

  /**
   * A board's result, checked against the challenge as it is now: a board finished after the
   * deadline does not count, like one not played (its time is when the table finished it, so a
   * result that reaches the challenge late still counts). The last one marks the participant
   * finished, and may finish the challenge before its deadline
   */
  result(result: ChallengeResult): Challenge {
    const c = this.require()
    const player = c.players.find((p) => p.userId === result.userId)
    const counts = isOpenChallenge(c.status) && result.playedAt < c.deadline
    if (!counts || !player || c.results.some((r) => r.userId === result.userId && r.seq === result.seq)) return c
    const { store, now } = this.deps
    store.transaction(() => {
      store.addResult(c.id, result)
      if (playedSeqs(c, result.userId).size + 1 >= c.deals.boards.length)
        store.updatePlayer(c.id, { ...player, finishedAt: now() })
    })
    this.finishEarly()
    return this.require()
  }

  /** A challenge left with too few people is cancelled; one where everyone left is done finishes */
  forget(userId: string): Challenge {
    this.require()
    if (this.deps.store.forgetIn(this.id, userId, this.deps.now())) this.finishEarly()
    return this.require()
  }

  /**
   * Puts the challenge's one job (`challenge:<id>`) at its next time point: the reminder 12 hours
   * before the deadline until it went out, then the deadline. Jobs are not stored: whoever holds
   * the challenge schedules it again after a load
   */
  schedule() {
    const challenge = this.get()
    const at = challenge ? nextChallengeTime(challenge) : null
    if (at === null) return
    const { scheduler, now } = this.deps
    scheduler.add(`challenge:${this.id}`, 'challenge', Math.max(0, at - now()), () => this.due())
  }

  /**
   * The challenge's job. At the deadline it settles (`deadlineOutcome`); before it, from 12 hours
   * out, it notes the reminder (the club sends it), once. Either way the time is checked again
   * here, so a job run early only puts itself back
   */
  async due() {
    if (this.deps.here && !this.deps.here()) return
    const challenge = this.get()
    if (!challenge || !isOpenChallenge(challenge.status)) return
    const now = this.deps.now()
    if (now >= challenge.deadline) {
      const change = deadlineOutcome(challenge, now)
      if (change) this.apply(change)
      await this.deps.changed(this.require())
      return
    }
    if (challenge.remindedAt === undefined && now >= challenge.deadline - REMINDER_MS) {
      this.deps.store.setReminded(this.id, now)
      await this.deps.changed(this.require())
    }
    this.schedule()
  }
}

/** The error for a step `challenge-flow.ts` refused; a challenge one may not see is a 404 */
function refusal(code: ConstructorParameters<typeof ClubError>[0]): ClubError {
  return new ClubError(code, {}, code === 'challengeGone' ? 404 : 400)
}

/** The challenge as the club is told it in this same object: there is no change number to compare */
const local = (challenge: Challenge): EventSnapshot => ({ challenge, rev: 0 })

/**
 * The challenges that live in the club's own object, on its tables and its queue: the switch off
 * (`EVENT_OBJECTS` not `on`), the challenges not moved out yet, and most tests
 */
export class LocalEvents implements Events {
  private readonly deps: Omit<ChallengeEventDeps, 'here'> & { here: (id: string) => boolean }

  constructor(deps: Omit<ChallengeEventDeps, 'here'> & { here: (id: string) => boolean }) {
    this.deps = deps
  }

  /** The challenge as plain logic, for the club's load (scheduling) and the move out */
  event(id: string): ChallengeEvent {
    const { here, ...deps } = this.deps
    return new ChallengeEvent(id, { ...deps, here: () => here(id) })
  }

  get(id: string): EventApi {
    const event = this.event(id)
    return {
      adopt: async (challenge) => local(event.adopt(challenge)),
      answer: async (userId, accept) => local(event.answer(userId, accept)),
      cancel: async (userId) => local(event.cancel(userId)),
      started: async (userId) => local(event.started(userId)),
      result: async (result) => local(event.result(result)),
      forget: async (userId) => local(event.forget(userId)),
    }
  }
}
