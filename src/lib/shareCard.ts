import type { Contract } from '../../shared/auction.ts'
import type { ChallengeScoring } from '../../shared/challenge-scoring.ts'
import type { ChallengeView } from '../../shared/challenge.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { formatScore } from './challenges.ts'

/**
 * The result share card (`e7-t24`, AC-7.7): a picture of the member's place, total and their
 * best board of a challenge, drawn in the browser from what the server already sent them. Only a
 * ranked participant has one, so it never shows anything the standings did not.
 */

export interface ShareCardData {
  rank: number
  /** How many were ranked */
  of: number
  total: number
  scoring: ChallengeScoring
  final: boolean
  /**
   * 最精彩的一副 (建議預設): the board where the member scored best in the challenge's scoring; on a
   * tie the earlier board
   */
  best?: { seq: number; boardNo: number; value: number; contract?: Contract | null; declarerTricks?: number | null }
}

/** The card's numbers, or null when the member is not ranked (still playing, unfinished, or not in it) */
export function shareCardData(c: ChallengeView, userId: string): ShareCardData | null {
  const standings = c.standings
  const me = standings?.ranked.find((r) => r.userId === userId)
  if (!standings || !me) return null
  let best: { seq: number; value: number } | undefined
  for (const [i, value] of (me.boards ?? []).entries()) if (!best || value > best.value) best = { seq: i + 1, value }
  const traveller = best && c.travellers?.find((x) => x.seq === best.seq)
  const entry = traveller?.entries.find((e) => e.userId === userId)
  return {
    rank: me.rank,
    of: standings.ranked.length,
    total: me.total,
    scoring: standings.scoring,
    final: standings.final,
    ...(best && {
      best: {
        seq: best.seq,
        boardNo: traveller?.boardNo ?? best.seq,
        value: best.value,
        ...(entry && { contract: entry.contract, declarerTricks: entry.declarerTricks }),
      },
    }),
  }
}

const STRAIN_TEXT = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' } as const

/** 4♠X S +1, or -- when passed out: bridge shorthand, the same in every language */
export function contractText(contract: Contract | null, tricks?: number | null) {
  if (!contract) return '--'
  const result = tricks === null || tricks === undefined ? '' : ` ${resultLabel(contract, tricks)}`
  return `${contract.level}${STRAIN_TEXT[contract.strain]}${contract.doubled} ${contract.declarer}${result}`
}

/** What the card says, already in the viewer's language */
export interface ShareCardText {
  site: string
  title: string
  rank: string
  of: string
  totalLabel: string
  total: string
  bestLabel?: string
  best?: string
  footer: string
}

/** The colours the card is drawn in (from the theme's tokens) */
export interface ShareCardColors {
  background: string
  text: string
  muted: string
  accent: string
  rule: string
}

export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const

const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif'

/** Draws the card on a 1200 × 630 canvas (the size link previews use) */
export function drawShareCard(ctx: CanvasRenderingContext2D, text: ShareCardText, colors: ShareCardColors) {
  const { width, height } = SHARE_CARD_SIZE
  const pad = 72
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, width, height)
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = colors.muted
  ctx.font = `600 28px ${FONT}`
  ctx.fillText(text.site, pad, pad + 10)

  ctx.fillStyle = colors.text
  ctx.font = `800 56px ${FONT}`
  ctx.fillText(text.title, pad, pad + 90, width - 2 * pad)

  ctx.fillStyle = colors.rule
  ctx.fillRect(pad, pad + 120, 120, 6)

  ctx.fillStyle = colors.accent
  ctx.font = `800 120px ${FONT}`
  ctx.fillText(text.rank, pad, pad + 290)
  ctx.fillStyle = colors.muted
  ctx.font = `600 30px ${FONT}`
  ctx.fillText(text.of, pad, pad + 340)

  const right = width / 2 + 40
  ctx.fillStyle = colors.muted
  ctx.font = `600 30px ${FONT}`
  ctx.fillText(text.totalLabel, right, pad + 200)
  ctx.fillStyle = colors.text
  ctx.font = `800 88px ${FONT}`
  ctx.fillText(text.total, right, pad + 290, width - right - pad)

  if (text.bestLabel && text.best) {
    ctx.fillStyle = colors.muted
    ctx.font = `600 28px ${FONT}`
    ctx.fillText(text.bestLabel, pad, height - pad - 50)
    ctx.fillStyle = colors.text
    ctx.font = `700 40px ${FONT}`
    ctx.fillText(text.best, pad, height - pad, width / 2 + 120)
  }
  ctx.fillStyle = colors.muted
  ctx.font = `500 24px ${FONT}`
  ctx.textAlign = 'right'
  ctx.fillText(text.footer, width - pad, height - pad)
  ctx.textAlign = 'left'
}

/** The card's text from its numbers */
export function shareCardText(
  data: ShareCardData,
  t: {
    site: string
    title: string
    rank: (n: number) => string
    of: (n: number, final: boolean) => string
    totalLabel: string
    bestLabel: string
    bestLine: (boardNo: number, contract: string, score: string) => string
    footer: string
  },
): ShareCardText {
  const best = data.best
  return {
    site: t.site,
    title: t.title,
    rank: t.rank(data.rank),
    of: t.of(data.of, data.final),
    totalLabel: t.totalLabel,
    total: formatScore(data.total, data.scoring),
    ...(best && {
      bestLabel: t.bestLabel,
      best: t.bestLine(
        best.boardNo,
        best.contract === undefined ? '' : contractText(best.contract, best.declarerTricks),
        formatScore(best.value, data.scoring),
      ),
    }),
    footer: t.footer,
  }
}
