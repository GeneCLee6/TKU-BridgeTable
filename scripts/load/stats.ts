/**
 * Latency samples per kind of action, and the counts a load run keeps (docs/LOAD.md). Node only,
 * never in the bundle
 */

export interface Summary {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, at)]
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b)
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.at(-1) ?? 0),
  }
}

/** What every simulated member adds to: latencies by kind, and counts by name */
export class Recorder {
  readonly samples = new Map<string, number[]>()
  readonly counts = new Map<string, number>()

  add(kind: string, ms: number) {
    let list = this.samples.get(kind)
    if (!list) this.samples.set(kind, (list = []))
    list.push(ms)
  }

  count(name: string, by = 1) {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by)
  }

  get(name: string) {
    return this.counts.get(name) ?? 0
  }

  /** Every kind's summary, plus `all` over the game actions (calls and cards) */
  latency(): Record<string, Summary> {
    const out: Record<string, Summary> = {}
    const game: number[] = []
    for (const [kind, values] of [...this.samples].sort(([a], [b]) => a.localeCompare(b))) {
      out[kind] = summarize(values)
      if (kind === 'call' || kind === 'play') game.push(...values)
    }
    if (game.length) out.game = summarize(game)
    return out
  }
}

/** A Markdown table of the latencies, for the PR and docs/LOAD.md */
export function latencyTable(latency: Record<string, Summary>): string {
  const rows = Object.entries(latency).map(
    ([kind, s]) => `| ${kind} | ${s.count} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} |`,
  )
  return ['| 動作 | 次數 | p50 ms | p95 ms | p99 ms | 最大 ms |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n')
}
