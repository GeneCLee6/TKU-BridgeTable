import { describe as group, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { nextSeat, type Seat } from '../../shared/cards.ts'
import { LANGS } from '../../shared/messages.ts'
import { union } from '../../shared/robot/system/combine.ts'
import { callText, describe } from '../../shared/robot/system/describe.ts'
import { explain } from '../../shared/robot/system/engine.ts'
import { ANY, CONVENTIONS, NOTES, type Spec, type System } from '../../shared/robot/system/spec.ts'

function auctionOf(calls: string, dealer: Seat = 'N'): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

group('union: one call from several rules', () => {
  it('keeps each feature at its widest, as GIB describes a raise of a weak two', () => {
    const weak: Spec = { tp: [4, ANY], len: { S: [4, 13] }, notes: [{ key: 'toPlay' }] }
    const strong: Spec = { tp: [16, ANY], len: { S: [2, 13] }, notes: [{ key: 'toPlay' }] }
    expect(union([weak, strong])).toEqual({ tp: [4, ANY], len: { S: [2, 13] }, notes: [{ key: 'toPlay' }] })
  })

  it('drops what not every rule shows', () => {
    const a: Spec = { name: 'stayman', hcp: [8, ANY], len: { H: [4, 4] }, forcing: 'oneRound', artificial: true }
    const b: Spec = { name: 'stayman', hcp: [0, 7], forcing: 'oneRound', artificial: true }
    expect(union([a, b])).toEqual({ name: 'stayman', hcp: [0, ANY], forcing: 'oneRound', artificial: true })
    expect(union([{ forcing: 'game' }, { forcing: 'oneRound' }])).toEqual({ forcing: 'oneRound' })
    expect(union([{ name: 'transfer' }, { name: 'texas' }])).toEqual({})
    expect(union([{ stop: { D: 'stop' } }, { stop: { D: 'likely' } }])).toEqual({ stop: { D: 'likely' } })
    expect(union([{ trump: 'S', keycards: [0, 3] }, { trump: 'S', keycards: [1] }])).toEqual({ trump: 'S', keycards: [0, 1, 3] })
  })

  it('keeps a single rule as it is, and nothing from none', () => {
    const only: Spec = { hcp: [15, 17], balanced: true }
    expect(union([only])).toBe(only)
    expect(union([])).toEqual({})
  })
})

group('describe: what a call shows, in words', () => {
  it('writes the features in GIB order', () => {
    const opening: Spec = { len: { S: [5, 13] }, hcp: [11, 21], tp: [12, 22] }
    expect(describe(opening, 'zh')).toBe('5+ 張♠，11–21 大牌點，12–22 總點')
    expect(describe(opening, 'en')).toBe('5+ ♠; 11–21 HCP; 12–22 total points')
    expect(describe({ hcp: [15, 17], balanced: true }, 'zh')).toBe('15–17 大牌點，平均牌型')
    expect(describe({ len: { H: [6, 6] }, hcp: [0, 9] }, 'zh')).toBe('6 張♥，0–9 大牌點')
  })

  it('names conventions and adds their notes', () => {
    const stayman: Spec = { name: 'stayman', hcp: [8, ANY], notes: [{ key: 'asksMajor' }], forcing: 'oneRound', artificial: true }
    expect(describe(stayman, 'zh')).toBe('Stayman：詢問 4 張高花，8+ 大牌點，迫叫一圈')
    expect(describe(stayman, 'en')).toBe('Stayman: asks for a 4-card major; 8+ HCP; forcing')
    const transfer: Spec = { name: 'transfer', len: { H: [5, 13] }, notes: [{ key: 'transferTo', strain: 'H' }] }
    expect(describe(transfer, 'zh')).toBe('轉換：轉到♥，5+ 張♥')
    const choice: Spec = { notes: [{ key: 'choiceOf', calls: ['3N', '4H'] }] }
    expect(describe(choice, 'en')).toBe('choice of 3NT or 4♥')
    const answer: Spec = { name: 'keycards', trump: 'S', keycards: [0, 3] }
    expect(describe(answer, 'zh')).toBe('回答關鍵張：0 或 3 張關鍵張')
  })

  it('shows quality, stoppers and controls', () => {
    const spec: Spec = { quality: { S: 'solid' }, stop: { D: 'stop' }, controls: [4, ANY], tp: [17, ANY] }
    expect(describe(spec, 'zh')).toBe('♠ 堅強，17+ 總點，♦ 有擋，4+ 控制')
    expect(describe(spec, 'en')).toBe('solid ♠; 17+ total points; stop in ♦; 4+ controls')
  })

  it('says nothing for a call that shows nothing in particular', () => {
    expect(describe({}, 'zh')).toBe('')
    expect(describe({ hcp: [0, ANY], len: { S: [0, 13] } }, 'en')).toBe('')
    expect(describe({ artificial: true }, 'zh')).toBe('人工叫')
  })

  it('has words for every convention and note in every language', () => {
    for (const lang of LANGS) {
      for (const name of CONVENTIONS) expect(describe({ name }, lang), `${name} ${lang}`).toBeTruthy()
      for (const key of NOTES) expect(describe({ notes: [{ key, strain: 'S', calls: ['3N', '4S'], counts: [1, 4] }] }, lang), `${key} ${lang}`).toBeTruthy()
    }
  })

  it('writes calls with suit symbols', () => {
    expect(callText('3N')).toBe('3NT')
    expect(callText('4S')).toBe('4♠')
    expect(callText('X')).toBe('X')
  })
})

group('explain: every call before it is made', () => {
  const toy: System = {
    id: 'gib',
    books: [
      {
        after: '2S (P)',
        rules: [
          { call: '4S', shows: { tp: [4, ANY], len: { S: [4, 13] } }, when: (h) => h.hcp < 10 },
          { call: '4S', shows: { tp: [16, ANY], len: { S: [2, 13] } } },
          { call: '2N', shows: { name: 'featureAsk', hcp: [15, ANY], forcing: 'oneRound', artificial: true } },
          { call: 'P', shows: { hcp: [0, 14] } },
        ],
      },
    ],
  }

  it('puts together the rules that make each call', () => {
    const calls = explain(toy, auctionOf('2S P'), 'N')
    expect(calls.get('4S')).toEqual({ tp: [4, ANY], len: { S: [2, 13] } })
    expect(calls.get('2N')).toEqual({ name: 'featureAsk', hcp: [15, ANY], forcing: 'oneRound', artificial: true })
    expect(calls.get('P')).toEqual({ hcp: [0, 14] })
    expect(calls.has('3S')).toBe(false)
  })

  it('knows nothing outside its books', () => {
    expect(explain(toy, auctionOf('1S P'), 'N').size).toBe(0)
  })

  it('lets a later book add only the calls an earlier book does not make', () => {
    const layered: System = {
      id: 'gib',
      books: [
        { after: '1S (P)', rules: [{ call: '2S', shows: { len: { S: [3, 13] }, tp: [7, 10] } }], more: true },
        { rules: [{ call: '2S', shows: { tp: [0, ANY] } }, { call: '3S', shows: { tp: [11, 12] } }] },
      ],
    }
    const calls = explain(layered, auctionOf('1S P'), 'N')
    expect(calls.get('2S')).toEqual({ len: { S: [3, 13] }, tp: [7, 10] })
    expect(calls.get('3S')).toEqual({ tp: [11, 12] })
  })
})
