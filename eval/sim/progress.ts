/** Progress and ETA on stderr: a line rewritten in a terminal, a line every 5% otherwise */
export class Progress {
  private readonly total: number
  private readonly label: string
  private readonly started = performance.now()
  private done = 0
  private shownAt = 0
  private shownPercent = -1

  constructor(total: number, label: string) {
    this.total = total
    this.label = label
  }

  add(n: number) {
    this.done += n
    const now = performance.now()
    const percent = Math.floor((this.done / this.total) * 20) * 5
    if (process.stderr.isTTY) {
      if (now - this.shownAt < 500 && this.done < this.total) return
      process.stderr.write(`\r${this.line()}`)
    } else if (percent !== this.shownPercent) {
      process.stderr.write(`${this.line()}\n`)
    }
    this.shownAt = now
    this.shownPercent = percent
  }

  private line(): string {
    const seconds = (performance.now() - this.started) / 1000
    const rate = this.done / Math.max(seconds, 0.001)
    const left = rate > 0 ? (this.total - this.done) / rate : 0
    return `${this.label}: ${this.done}/${this.total} (${((this.done / this.total) * 100).toFixed(1)}%) · ${rate.toFixed(1)}/s · ${clock(seconds)} elapsed · ETA ${clock(left)}`
  }

  /** Seconds the work took */
  finish(): number {
    if (process.stderr.isTTY) process.stderr.write(`\r${this.line()}\n`)
    return (performance.now() - this.started) / 1000
  }
}

/** 'h:mm:ss' */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
