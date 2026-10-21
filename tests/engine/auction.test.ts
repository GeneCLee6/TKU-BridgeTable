import { describe, expect, it } from 'vitest'
import {
  contractOf,
  isAuctionComplete,
  legalCalls,
  type AuctionCall,
} from '../../shared/auction.ts'
import { nextSeat, type Seat } from '../../shared/cards.ts'

/** Builds an auction from a dealer and space-separated calls */
function auction(dealer: Seat, calls: string): AuctionCall[] {
  return calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
}

describe('legalCalls', () => {
  it('allows every bid and a pass at the start, but no double', () => {
    const legal = legalCalls([], 'N')
    expect(legal.size).toBe(36)
    expect(legal.has('1C')).toBe(true)
    expect(legal.has('7N')).toBe(true)
    expect(legal.has('X')).toBe(false)
  })

  it('only allows higher bids', () => {
    const legal = legalCalls(auction('N', '1H'), 'N')
    expect(legal.has('1H')).toBe(false)
    expect(legal.has('1D')).toBe(false)
    expect(legal.has('1S')).toBe(true)
    expect(legal.has('2C')).toBe(true)
  })

  it('allows doubling an opponent but not partner', () => {
    expect(legalCalls(auction('N', '1H'), 'N').has('X')).toBe(true)
    expect(legalCalls(auction('N', '1H P'), 'N').has('X')).toBe(false)
    expect(legalCalls(auction('N', '1H P P'), 'N').has('X')).toBe(true)
  })

  it('allows redoubling only an opponent double', () => {
    expect(legalCalls(auction('N', '1H X'), 'N').has('XX')).toBe(true)
    expect(legalCalls(auction('N', '1H X P'), 'N').has('XX')).toBe(false)
    expect(legalCalls(auction('N', '1H X P P'), 'N').has('XX')).toBe(true)
    expect(legalCalls(auction('N', '1H X XX'), 'N').has('XX')).toBe(false)
    expect(legalCalls(auction('N', '1H X XX'), 'N').has('X')).toBe(false)
  })

  it('allows nothing once the auction is over', () => {
    expect(legalCalls(auction('N', '1H P P P'), 'N').size).toBe(0)
  })
})

describe('isAuctionComplete', () => {
  it.each([
    ['P P P P', true],
    ['P P P', false],
    ['P P P 1S', false],
    ['1S P P P', true],
    ['1S P P', false],
    ['P 1S P 2S P P P', true],
  ])('%s → %s', (calls, done) => {
    expect(isAuctionComplete(auction('N', calls))).toBe(done)
  })
})

describe('contractOf', () => {
  it('is null for a passed-out board', () => {
    expect(contractOf(auction('E', 'P P P P'))).toBeNull()
  })

  it('makes the first player of the side to name the strain declarer', () => {
    // N opens 1♠, S raises to 4♠: North declares
    expect(contractOf(auction('N', '1S P 2S P 4S P P P'))).toEqual({
      level: 4,
      strain: 'S',
      doubled: '',
      declarer: 'N',
    })
    // N opens 1♥, S bids 1♠, N supports: South declares spades
    expect(contractOf(auction('N', '1H P 1S P 2S P P P'))?.declarer).toBe('S')
  })

  it('records doubles and redoubles of the final bid only', () => {
    expect(contractOf(auction('N', '1N X P P P'))?.doubled).toBe('X')
    expect(contractOf(auction('N', '1N X XX P P P'))?.doubled).toBe('XX')
    expect(contractOf(auction('N', '1N X 2C P P P'))?.doubled).toBe('')
  })

  it('gives the contract to the defenders when they outbid', () => {
    const contract = contractOf(auction('S', '1C 1H P P P'))
    expect(contract).toMatchObject({ level: 1, strain: 'H', declarer: 'W' })
  })
})
