import { ClubError } from './errors.ts'
import type { EventWire } from './events.ts'
import { applyPairsStep, type PairsEvent, type PairsStep } from './pairs-flow.ts'

/**
 * How the club and the pairs events talk (ARCHITECTURE.md §5.20), the way it talks to the team
 * matches (`match-events.ts`, H2c). An event lives where it was created and stays there: in its
 * own `EventObject` (`idFromName('pairs:<id>')`) when `EVENT_OBJECTS=on` then, else in the club's
 * storage (`LocalPairs`). The club keeps a copy of every event (`pairs:<id>` in its storage, with
 * where it lives and the last change number written), and every page, list and check reads that.
 */

/** An event as it is after a change, with the change's number (`max(last + 1, now)`, so it never goes back) */
export interface PairsSnapshot {
  event: PairsEvent
  rev: number
}

/** What the club asks of one event. Each answers with the event as it is now; errors are `ClubError` */
export interface PairsApi {
  /** Takes a new event; one already there keeps what it has */
  adopt(event: PairsEvent): Promise<PairsSnapshot>
  /** One change, checked again on the event itself */
  step(step: PairsStep): Promise<PairsSnapshot>
}

export interface PairsWire {
  snapshot: PairsSnapshot | null
  error?: EventWire['error']
}

/** What one `EventObject` answers for a pairs event over RPC */
export interface PairsRpc {
  adoptPairs(event: PairsEvent): Promise<PairsWire>
  stepPairs(step: PairsStep): Promise<PairsWire>
}

/** A change number: never smaller than the last one, even after an eviction */
export const nextRev = (last: number, now: number) => Math.max(last + 1, now)

export interface LocalPairsDeps {
  /** The event as the club keeps it (here the copy is the event) */
  get: (id: string) => PairsSnapshot | null
  now: () => number
}

/** The events that live in the club's own storage: each step runs on the club's copy */
export class LocalPairs {
  private readonly deps: LocalPairsDeps

  constructor(deps: LocalPairsDeps) {
    this.deps = deps
  }

  get(id: string): PairsApi {
    return {
      adopt: async (event) => this.deps.get(id) ?? { event: structuredClone(event), rev: nextRev(0, this.deps.now()) },
      step: async (step) => {
        const known = this.deps.get(id)
        if (!known) throw new ClubError('pairsGone', {}, 404)
        const event = structuredClone(known.event)
        applyPairsStep(event, step)
        return JSON.stringify(event) === JSON.stringify(known.event) ? known : { event, rev: nextRev(known.rev, this.deps.now()) }
      },
    }
  }
}

export interface RemotePairsDeps {
  /** Every snapshot an object answers with, refusals included: the club keeps its copy up to date */
  snapshot: (snapshot: PairsSnapshot) => void
  /** The club's copy, for an object that answers it has none: it adopts the copy and the call is made again */
  copy: (id: string) => PairsEvent | null
}

/** The events in their own `EventObject`s, reached over RPC */
export class RemotePairs {
  private readonly stub: (id: string) => PairsRpc
  /** Set by the club */
  attach: RemotePairsDeps = { snapshot: () => {}, copy: () => null }

  constructor(stub: (id: string) => PairsRpc) {
    this.stub = stub
  }

  get(id: string): PairsApi {
    const rpc = this.stub(id)
    const unwrap = (wire: PairsWire): PairsSnapshot | null => {
      if (wire.snapshot) this.attach.snapshot(wire.snapshot)
      if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
      return wire.snapshot
    }
    return {
      adopt: async (event) => {
        const found = unwrap(await rpc.adoptPairs(event))
        if (!found) throw new ClubError('serverError', {}, 503)
        return found
      },
      step: async (step) => {
        const found = unwrap(await rpc.stepPairs(step))
        if (found) return found
        // The object has no event (its first adopt was lost): it takes the club's copy, and the step is made again
        const copy = this.attach.copy(id)
        if (!copy) throw new ClubError('pairsGone', {}, 404)
        unwrap(await rpc.adoptPairs(copy))
        const again = unwrap(await rpc.stepPairs(step))
        if (!again) throw new ClubError('serverError', {}, 503)
        return again
      },
    }
  }
}
