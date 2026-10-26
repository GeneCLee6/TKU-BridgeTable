import type { RobotKind } from '../../shared/protocol.ts'
import type { CompareOptions, CompareRecord } from './compare.ts'
import type { BiddingOptions, BiddingRecord } from './bidding.ts'
import type { DdTable } from './dds.ts'
import type { LeadRecord } from './leads.ts'

/**
 * What the pool sends a worker thread (eval/sim/README.md §1): a kind of work and the numbers of
 * the boards to do, which the worker deals itself from the seed (`eval/deals.ts`), so the boards
 * never travel between threads; and what comes back.
 */
export type Job =
  | { kind: 'tables'; seed: string; boards: number[] }
  | { kind: 'leads'; seed: string; boards: number[]; system: RobotKind; samples: number }
  | { kind: 'compare'; seed: string; boards: number[]; system: RobotKind; options: CompareOptions }
  | { kind: 'bidding'; seed: string; boards: number[]; system: RobotKind; options: BiddingOptions }

export interface TableRecord {
  board: number
  table: DdTable
}

export type JobResult = TableRecord | LeadRecord | CompareRecord | BiddingRecord

export type WorkerMessage = { id: number; progress: number } | { id: number; results: JobResult[] } | { id: number; error: string } | { ready: true }
