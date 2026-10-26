import { describe, expect, it } from 'vitest'
import { patternProblem } from '../../shared/robot/system/context.ts'
import {
  ANY,
  CONVENTIONS,
  type Book,
  type Convention,
  type Spec,
} from '../../shared/robot/system/spec.ts'
import {
  SPEC_ANY,
  auctionPatterns,
  expandCall,
  readMeaning,
  toSystemSpec,
  type SpecConventionName,
  type SpecInputConvention,
  type SpecRule,
  type SpecShows,
} from '../../shared/systemSpec.ts'

// The spec's types are the robot's: what a call shows is a `Spec`, a rule fits in a `Book`
type Assignable<From, To> = [From] extends [To] ? true : false
const typesFit: [Assignable<SpecShows, Spec>, Assignable<SpecConventionName, Convention>] = [
  true,
  true,
]
const asBook = (rule: SpecRule): Book => ({
  after: rule.after,
  rules: [{ call: rule.call, shows: rule.shows }],
})

describe('system spec types', () => {
  it('fit the robot', () => {
    expect(typesFit).toEqual([true, true])
    expect(SPEC_ANY).toBe(ANY)
    const names: SpecConventionName[] = [
      'stayman',
      'texas',
      'gerber',
      'splinter',
      'lebensohl',
      'michaels',
      'drury',
      'rkcb',
      'ekb',
      'blackwood',
      'negative',
      'responsive',
    ]
    for (const name of names) expect(CONVENTIONS).toContain(name)
  })
})

describe('expandCall', () => {
  it('writes calls in the robot notation', () => {
    expect(expandCall('1NT')).toEqual(['1N'])
    expect(expandCall('PASS')).toEqual(['P'])
    expect(expandCall('xx')).toEqual(['XX'])
  })

  it('splits the handouts’ shared rows', () => {
    expect(expandCall('1D/H/S')).toEqual(['1D', '1H', '1S'])
    expect(expandCall('4D/5D')).toEqual(['4D', '5D'])
    expect(expandCall('1NT/2NT')).toEqual(['1N', '2N'])
    expect(expandCall('2C/NT')).toEqual(['2C', '2N'])
  })

  it('refuses what is not a call', () => {
    expect(expandCall('?')).toBeNull()
    expect(expandCall('---')).toBeNull()
    expect(expandCall('8D')).toBeNull()
  })
})

describe('auctionPatterns', () => {
  it('counts back from the question', () => {
    expect(auctionPatterns(['1NT', '', '?'])).toEqual({ after: ['1N (P)'] })
    expect(auctionPatterns(['1S', '', '2NT', '', '3S', '', '?'])).toEqual({
      after: ['1S (P) 2N (P) 3S (P)'],
    })
    expect(auctionPatterns(['2C', 'X', '?'])).toEqual({ after: ['2C (X)'] })
    expect(auctionPatterns(['?'])).toEqual({ after: [''] })
  })

  it('reads an auction the opponents opened', () => {
    expect(auctionPatterns(['2H', '?'])).toEqual({ after: ['(2H)'] })
    expect(auctionPatterns(['', '', '1H', '2NT', '?'])).toEqual({ after: ['1H (2N)'] })
    expect(auctionPatterns(['2D', 'X', 'P', '2NT', 'P', '3C', 'P', '?'])).toEqual({
      after: ['(2D) X (P) 2N (P) 3C (P)'],
    })
  })

  it('leaves out passes before the opening and ignores notes on calls', () => {
    expect(auctionPatterns(['P', '', '1H', '', '?'])).toEqual({ after: ['1H (P)'] })
    expect(
      auctionPatterns(['1S', '', '2NT', '', '3C', '', { call: '3D', note: '詢問' }, '', '?']),
    ).toEqual({
      after: ['1S (P) 2N (P) 3C (P) 3D (P)'],
    })
  })

  it('reads --- and -- as pass', () => {
    expect(auctionPatterns(['2D', '---', '?'])).toEqual({ after: ['2D (P)'] })
    expect(auctionPatterns(['1NT', '--', '2D', 'X', '---', '---', '?'])).toEqual({
      after: ['1N (P) 2D (X) P (P)'],
    })
  })

  it('reads every way a shared cell can go', () => {
    expect(auctionPatterns(['1C/D', '', '1H', '', '?'])).toEqual({
      after: ['1C (P) 1H (P)', '1D (P) 1H (P)'],
    })
  })

  it('gives up on what it cannot read', () => {
    expect(auctionPatterns(['1H', 'X', '2H', 'X'])).toEqual({ reason: 'noQuestion' })
    expect(auctionPatterns(['1NT', { call: '', note: '2X' }, '?'])).toEqual({
      reason: 'auctionCell',
      detail: '{2X}',
    })
    expect(auctionPatterns(['1H', '', '', '', '?'])).toEqual({ reason: 'auctionCell', detail: '' })
  })

  it('makes patterns the robot accepts', () => {
    for (const calls of [
      ['1NT', '', '?'],
      ['2H', '?'],
      ['', '', '1H', '2NT', '?'],
      ['2C', 'X', '?'],
    ]) {
      const result = auctionPatterns(calls)
      if (!('after' in result)) throw new Error('unread')
      for (const p of result.after) expect(patternProblem(p)).toBeNull()
    }
  })
})

describe('readMeaning', () => {
  it('reads high-card ranges', () => {
    expect(readMeaning('15-17').shows).toEqual({ hcp: [15, 17] })
    expect(readMeaning('13-15 點').shows).toEqual({ hcp: [13, 15] })
    expect(readMeaning('5~8 HCP').shows).toEqual({ hcp: [5, 8] })
    expect(readMeaning('14↑').shows).toEqual({ hcp: [14, ANY] })
    expect(readMeaning('10點以上').shows).toEqual({ hcp: [10, ANY] })
    expect(readMeaning('19+ HCP').shows).toEqual({ hcp: [19, ANY] })
    expect(readMeaning('9點↓').shows).toEqual({ hcp: [0, 9] })
  })

  it('does not take shapes for points', () => {
    expect(readMeaning('5-4高花').shows).toEqual({})
    expect(readMeaning('5-5低花').shows).toEqual({})
    expect(readMeaning('5-3-3-2').shows).toEqual({})
    expect(readMeaning('11-14↑').shows).toEqual({})
  })

  it('reads lengths', () => {
    expect(readMeaning('5張♥').shows).toEqual({ len: { H: [5, ANY] } })
    expect(readMeaning('5張♥，16~18，5431').shows).toEqual({ len: { H: [5, 5] }, hcp: [16, 18] })
    expect(readMeaning('剛好5張♥').shows).toEqual({ len: { H: [5, 5] } })
    expect(readMeaning('6張↑♦').shows).toEqual({ len: { D: [6, ANY] } })
    expect(readMeaning('5張♣↑').shows).toEqual({ len: { C: [5, ANY] } })
    expect(readMeaning('4+♠').shows).toEqual({ len: { S: [4, ANY] } })
    expect(readMeaning('6張黑桃↑').shows).toEqual({ len: { S: [6, ANY] } })
    expect(readMeaning('單張♦').shows).toEqual({ len: { D: [1, 1] } })
    expect(readMeaning('♠ void').shows).toEqual({ len: { S: [0, 0] } })
    expect(readMeaning('3張♥＋♦短＋5張♠↑').shows).toEqual({ len: { H: [3, ANY], S: [5, ANY] } })
  })

  it('leaves a suit shared between calls alone', () => {
    expect(readMeaning('16-18點，4張↑♦/♥，倒叫。')).toEqual({
      shows: { hcp: [16, 18] },
      unparsed: '4張↑♦/♥，倒叫',
    })
  })

  it('reads shape and forcing', () => {
    expect(readMeaning('13-14點，平均牌型。').shows).toEqual({ hcp: [13, 14], balanced: true })
    expect(readMeaning('平均牌型18~19(5332、6322、7222)').shows).toEqual({ hcp: [18, 19] })
    expect(readMeaning('12+↑，GF，4張♣↑').shows).toEqual({
      hcp: [12, ANY],
      forcing: 'game',
      len: { C: [4, ANY] },
    })
    expect(readMeaning('6張↑♣，F一圈').shows).toEqual({ len: { C: [6, ANY] }, forcing: 'oneRound' })
    expect(readMeaning('詢問叫（NGF）').shows).toEqual({})
  })

  it('reads convention names', () => {
    expect(readMeaning('RKCB').shows).toEqual({ name: 'rkcb' })
    expect(readMeaning('負性賭倍。').shows).toEqual({ name: 'negative' })
  })

  it('skips negations, maybes, other players and brackets', () => {
    expect(readMeaning('3張♥，沒有4張♣或是4張♦(fit同伴叫過之高花)')).toEqual({
      shows: { len: { H: [3, ANY] } },
      unparsed: '沒有4張♣或是4張♦(fit同伴叫過之高花)',
    })
    expect(readMeaning('5張♥的邀請6NT(可能有4張低花，後續答叫詳最前面)').shows).toEqual({
      len: { H: [5, ANY] },
    })
    expect(readMeaning('迫叫，通常是4張♥，短♠，17↑').shows).toEqual({
      forcing: 'oneRound',
      hcp: [17, ANY],
    })
    expect(readMeaning('5張+不迫叫，5~8 HCP。').shows).toEqual({ hcp: [5, 8] })
  })

  it('takes nothing when the text says two things', () => {
    expect(readMeaning('12-14，15-17').shows).toEqual({})
  })

  it('leaves at-most lengths and other counts alone', () => {
    expect(readMeaning('6張♥↑，1張♣↓')).toEqual({
      shows: { len: { H: [6, ANY] } },
      unparsed: '1張♣↓',
    })
    expect(readMeaning('4+♥，牌值為4~5的牌').shows).toEqual({ len: { H: [4, ANY] } })
    expect(readMeaning('低花55↑，詢問低花').shows).toEqual({})
  })

  it('skips a negated name and what to avoid', () => {
    expect(readMeaning('否定stayman，13點↑').shows).toEqual({ hcp: [13, ANY] })
    expect(readMeaning('通常4張 但可能3張，避免5張♥連叫兩次。').shows).toEqual({})
  })

  it('says when it read everything', () => {
    expect(readMeaning('15-17，5張♥')).toEqual({ shows: { hcp: [15, 17], len: { H: [5, ANY] } } })
  })
})

describe('toSystemSpec', () => {
  const content: SpecInputConvention[] = [
    {
      slug: 'nt',
      sections: [
        {
          id: 'answers',
          blocks: [
            { kind: 'paragraph' },
            {
              kind: 'responses',
              auction: { calls: ['1NT', '', '?'] },
              rows: [
                { call: '2C', meaning: 'Stayman，8點↑' },
                { call: '4C', meaning: 'Gerber問A。' },
                { call: '2S', meaning: '待查', pending: '原文不清楚' },
                { call: '3C/D', meaning: '6張↑低花，邀請', note: '附註' },
                { call: '3H/S', meaning: '5-5，10點↑' },
                { call: '?', meaning: '15-17' },
                { call: '3NT', meaning: `1.10-12${String.fromCharCode(0x3000)}2.15-17` },
                { call: '3D', meaning: '5張♦，10-12或6張♦↑，8-10' },
                { call: '3S', meaning: '5張♠，10-12（或更多）' },
              ],
            },
          ],
          children: [
            {
              id: 'example',
              blocks: [
                {
                  kind: 'responses',
                  auction: { calls: ['1NT', 'P', '2C'] },
                  rows: [{ call: '2D', meaning: '5張♦' }],
                },
              ],
            },
          ],
        },
        { id: 'loose', blocks: [{ kind: 'responses', rows: [{ call: '2D', meaning: '5張♦' }] }] },
      ],
    },
  ]
  const spec = toSystemSpec(content, { id: 'club', version: 3 })

  it('keeps the profile and version', () => {
    expect(spec.profileId).toBe('club')
    expect(spec.version).toBe(3)
  })

  it('makes a rule per call, with the text word for word', () => {
    expect(spec.rules).toEqual([
      {
        after: ['1N (P)'],
        call: '2C',
        shows: { name: 'stayman', hcp: [8, ANY] },
        text: 'Stayman，8點↑',
        ref: { slug: 'nt', sectionId: 'answers' },
      },
      ...['3H', '3S'].map((call) => ({
        after: ['1N (P)'],
        call,
        shows: { hcp: [10, ANY] },
        text: '5-5，10點↑',
        unparsed: '5-5',
        ref: { slug: 'nt', sectionId: 'answers' },
      })),
    ])
    for (const rule of spec.rules) expect(asBook(rule).rules).toHaveLength(1)
  })

  it('lists what it could not read', () => {
    expect(spec.unresolved.map((u) => [u.ref.sectionId, u.call, u.reason, u.detail])).toEqual([
      ['answers', '4C', 'noConditions', undefined],
      ['answers', '2S', 'pending', undefined],
      ['answers', '3C/D', 'noConditions', undefined],
      ['answers', '?', 'call', undefined],
      ['answers', '3NT', 'alternatives', undefined],
      ['answers', '3D', 'alternatives', undefined],
      ['answers', '3S', 'bracketed', undefined],
      ['example', '2D', 'noQuestion', undefined],
      ['loose', '2D', 'noAuction', undefined],
    ])
    expect(spec.unresolved[0].shows).toEqual({ name: 'gerber' })
  })
})
