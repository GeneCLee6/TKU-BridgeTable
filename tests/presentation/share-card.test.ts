import { describe, expect, it } from 'vitest'
import type { ChallengeView } from '../../shared/challenge.ts'
import { contractText, drawShareCard, shareCardData, shareCardText } from '../../src/lib/shareCard.ts'
import { STRINGS } from '../../src/strings.ts'

/** The result share card (C9, e7-t24) */

const view = (over: Partial<ChallengeView> = {}): ChallengeView => ({
  id: 'c1',
  creatorId: 'amy',
  createdAt: 0,
  status: 'finished',
  deadline: 1000,
  endedAt: 900,
  settings: { scoring: 'mp', robotKind: 'tku', bestHand: false, justDeclare: false, days: 3, ranking: 'players' },
  boards: 3,
  players: [],
  standings: {
    final: true,
    scoring: 'mp',
    ranked: [
      { userId: 'ben', rank: 1, total: 75, boards: [100, 50, 75] },
      { userId: 'amy', rank: 2, total: 50, boards: [0, 100, 50] },
      { userId: 'cat', rank: 3, total: 25, boards: [0, 50, 100] },
    ],
    unfinished: [{ userId: 'dan', played: 1 }],
  },
  travellers: [
    {
      seq: 2,
      boardNo: 2,
      entries: [
        {
          userId: 'amy',
          boardId: 'b2',
          scoreNS: 420,
          contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' },
          declarerTricks: 11,
        },
      ],
    },
  ],
  ...over,
})

describe('shareCardData', () => {
  it('gives the place, the total and the best board with its contract', () => {
    expect(shareCardData(view(), 'amy')).toEqual({
      rank: 2,
      of: 3,
      total: 50,
      scoring: 'mp',
      final: true,
      best: {
        seq: 2,
        boardNo: 2,
        value: 100,
        contract: { level: 4, strain: 'S', doubled: '', declarer: 'S' },
        declarerTricks: 11,
      },
    })
  })

  it('takes the earlier board on a tie, without a contract when the traveller is not there', () => {
    expect(shareCardData(view(), 'ben')?.best).toEqual({ seq: 1, boardNo: 1, value: 100 })
  })

  it('has no card for someone not ranked, or before the standings may be seen', () => {
    expect(shareCardData(view(), 'dan')).toBeNull()
    expect(shareCardData(view({ standings: undefined }), 'amy')).toBeNull()
  })
})

describe('the card', () => {
  it('writes contracts in bridge shorthand', () => {
    expect(contractText({ level: 3, strain: 'N', doubled: 'X', declarer: 'E' }, 8)).toBe('3NTX E -1')
    expect(contractText(null)).toBe('AP')
  })

  it('says it in the viewer’s language and draws every line', () => {
    const t = STRINGS.zh
    const text = shareCardText(shareCardData(view(), 'amy')!, {
      site: '淡江牌桌',
      title: '每週社團挑戰',
      rank: t.shareCardRank,
      of: t.shareCardOf,
      totalLabel: '總成績',
      bestLabel: t.shareCardBest,
      bestLine: t.shareCardBestLine,
      footer: '2026/10/25',
    })
    expect(text).toMatchObject({ rank: '第 2 名', of: '共 3 人排名', total: '50%', best: '第 2 副 4♠ S +1 · 100%' })

    const drawn: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key) =>
        key === 'fillText' ? (s: string) => drawn.push(s) : typeof target[key as string] === 'undefined' ? () => {} : target[key as string],
      set: (target, key, value) => {
        target[key as string] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    drawShareCard(ctx, text, { background: '#000', text: '#fff', muted: '#888', accent: '#c90', rule: '#c90' })
    expect(drawn).toEqual(['淡江牌桌', '每週社團挑戰', '第 2 名', '共 3 人排名', '總成績', '50%', '最精彩的一副', '第 2 副 4♠ S +1 · 100%', '2026/10/25'])
  })
})
