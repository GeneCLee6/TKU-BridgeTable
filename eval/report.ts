import type { DeclarerCounts, MatchSummary } from './stats.ts'

/** A match's report in Markdown (for the terminal, a CI job summary or a PR) */

const signed = (n: number, digits = 2) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(digits)

export interface ReportHeading {
  a: string
  b: string
  /** Such as `boards 1–200 of tku-eval-v1` */
  boards: string
  /** Seconds the match took */
  seconds?: number
}

function countsRow(name: string, c: DeclarerCounts) {
  return `| ${name} | ${c.declared} | ${c.made} | ${c.down} | ${c.partscores} | ${c.games} | ${c.slams} | ${c.doubled} |`
}

export function matchReport(heading: ReportHeading, s: MatchSummary, verdict?: string): string {
  const time = heading.seconds === undefined ? '' : ` · ${heading.seconds.toFixed(1)} s`
  return [
    `#### A \`${heading.a}\` vs B \`${heading.b}\`${verdict ? ` — ${verdict}` : ''}`,
    '',
    `${s.boards} boards (${heading.boards}), two tables with the seats swapped${time}`,
    '',
    '| A against B | |',
    '| --- | --- |',
    `| IMP/board | **${signed(s.impsPerBoard)}** ± ${s.standardError.toFixed(2)} (SE) · 95% CI [${signed(s.ci95[0])}, ${signed(s.ci95[1])}] · total ${signed(s.imps, 0)} |`,
    `| MP | ${s.mpPercent.toFixed(1)}% |`,
    `| Boards won / lost / tied | ${s.won} / ${s.lost} / ${s.tied} |`,
    `| Same contract at both tables | ${s.sameContract} |`,
    `| Passed out (tables) | ${s.passedOut} |`,
    '',
    '| Declaring side | Declared | Made | Down | Partscores | Games | Slams | Doubled |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    countsRow(`A \`${heading.a}\``, s.a),
    countsRow(`B \`${heading.b}\``, s.b),
    '',
  ].join('\n')
}
