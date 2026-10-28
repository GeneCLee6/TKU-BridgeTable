import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { auctionPattern, bookKey, bookNoteFor, bookNotes, patternAuction, robotMeanings } from '../../shared/robot/system/book-spec.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import type { SpecRule, SystemSpec } from '../../shared/systemSpec.ts'

/** 淡江橋館's rules next to TKB's (BridgeHall e7-t03, e7-t04) */

const calls = (...list: string[]): Pick<AuctionCall, 'call'>[] => list.map((call) => ({ call }))

const rule = (after: string[], call: string, text: string, sectionId = 'a'): SpecRule => ({
  after,
  call,
  shows: {},
  text,
  ref: { slug: 'notrump-responses', sectionId },
})

const spec = (rules: SpecRule[]): SystemSpec => ({ profileId: 'club', version: 3, rules, unresolved: [] })

describe('auctionPattern', () => {
  it('writes the auction from the opening, the opponents in brackets', () => {
    expect(auctionPattern([])).toBe('')
    expect(auctionPattern(calls('P', 'P'))).toBe('')
    // Partner opened 1NT, right-hand opponent passed: our turn
    expect(auctionPattern(calls('1N', 'P'))).toBe('1N (P)')
    expect(auctionPattern(calls('P', '1N', 'P'))).toBe('1N (P)')
    // The opponents opened
    expect(auctionPattern(calls('1C'))).toBe('(1C)')
    expect(auctionPattern(calls('1C', 'X', 'P'))).toBe('(1C) X (P)')
  })
})

describe('bookNotes', () => {
  it('finds the words for a call after an auction', () => {
    const notes = bookNotes(spec([rule(['1N (P)'], '2C', 'Stayman，8點↑')]), 'k1')
    expect(notes.key).toBe('k1')
    expect(bookNoteFor(notes, calls('1N', 'P'), '2C')).toEqual({ text: 'Stayman，8點↑', slug: 'notrump-responses', sectionId: 'a' })
    expect(bookNoteFor(notes, calls('P', '1N', 'P'), '2C')?.text).toBe('Stayman，8點↑')
    expect(bookNoteFor(notes, calls('1N', 'P'), '2D')).toBeUndefined()
    expect(bookNoteFor(null, calls('1N', 'P'), '2C')).toBeUndefined()
  })

  it('reads every pattern of a rule', () => {
    const notes = bookNotes(spec([rule(['1C (P)', '1D (P)'], '1H', '4張♥')]), 'k')
    expect(Object.keys(notes.notes).sort()).toEqual([bookKey('1C (P)', '1H'), bookKey('1D (P)', '1H')])
  })

  it('leaves out a call two rows give different words', () => {
    const notes = bookNotes(
      spec([rule(['1N (P)'], '2C', 'Stayman'), rule(['1N (P)'], '2C', '傀儡Stayman', 'b'), rule(['1N (P)'], '2D', '轉換'), rule(['1N (P)'], '2D', '轉換', 'c')]),
      'k',
    )
    expect(notes.notes[bookKey('1N (P)', '2C')]).toBeUndefined()
    expect(notes.notes[bookKey('1N (P)', '2D')]).toMatchObject({ text: '轉換', sectionId: 'a' })
  })
})

describe('patternAuction', () => {
  it('deals the auction from North', () => {
    expect(patternAuction('')).toEqual([])
    expect(patternAuction('1N (P)')).toEqual([
      { seat: 'N', call: '1N' },
      { seat: 'E', call: 'P' },
    ])
  })

  it('refuses what is not a legal, open auction', () => {
    expect(patternAuction('1N P')).toBeNull()
    expect(patternAuction('1S (1H)')).toBeNull()
    expect(patternAuction('(*) 1N (P)')).toBeNull()
    expect(patternAuction('1N (P) P (P)')).toBeNull()
  })
})

describe('robotMeanings', () => {
  it('gives what TKB’s rules show, and null for a call no rule makes', () => {
    const [item] = robotMeanings(TKU, { items: [{ after: '', calls: ['1N', '7N'] }] })
    expect(item.after).toBe('')
    expect(item.meanings['1N']).toMatchObject({ hcp: [15, 17], balanced: true })
    expect(item.meanings['1N']!.text).toContain('15–17')
    expect(item.meanings['7N']).toBeNull()
  })

  it('answers an auction it cannot read with nulls', () => {
    const [item] = robotMeanings(TKU, { items: [{ after: '1S (1H)', calls: ['2C'] }] })
    expect(item.meanings).toEqual({ '2C': null })
  })
})
