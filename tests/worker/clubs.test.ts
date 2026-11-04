// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CLUB_HEADER,
  CLUB_IDS,
  clubIdOfObject,
  clubObjectName,
  clubOfClubObject,
  clubOfScopedName,
  clubStoragePrefix,
  DEFAULT_CLUB_ID,
  knownClubs,
  requestClubId,
} from '../../shared/clubs.ts'

/** One Durable Object per club (e12-t02, BridgeBook e10-t10) */
describe('the clubs', () => {
  it('keeps 淡江 in the object it has always been in', () => {
    expect(DEFAULT_CLUB_ID).toBe('tku')
    expect(CLUB_IDS).toEqual(['tku'])
    expect(clubObjectName('tku')).toBe('club')
    expect(clubIdOfObject('club')).toBe('tku')
  })

  it('knows no other club', () => {
    expect(clubObjectName('ntu')).toBeNull()
    expect(clubObjectName('club')).toBeNull()
    expect(clubObjectName('constructor')).toBeNull()
    expect(clubIdOfObject('ntu')).toBeNull()
    expect(clubIdOfObject(undefined)).toBeNull()
  })

  it('reads the club from the header, else the query, else 淡江', () => {
    const at = (path: string, headers: Record<string, string> = {}) => requestClubId(new Request(`https://example.org${path}`, { headers }))
    expect(at('/api/me')).toBe('tku')
    expect(at('/api/me', { [CLUB_HEADER]: 'tku' })).toBe('tku')
    expect(at('/ws?club=tku')).toBe('tku')
    expect(at('/api/me', { [CLUB_HEADER]: '' })).toBe('tku')
    expect(at('/api/me', { [CLUB_HEADER]: 'ntu' })).toBeNull()
    expect(at('/ws?club=ntu')).toBeNull()
    expect(at('/api/me?club=tku', { [CLUB_HEADER]: 'ntu' })).toBeNull()
  })
})

/** A second club, and the names outside a club's object (e12-t03) */
describe('more clubs', () => {
  const known = knownClubs('ntu, Bad Id, tku,ntu')

  it('serves the clubs CLUBS names besides 淡江, only ids that look like one', () => {
    expect(knownClubs(undefined)).toEqual(['tku'])
    expect(known).toEqual(['tku', 'ntu'])
    expect(clubObjectName('ntu', known)).toBe('club:ntu')
    expect(clubIdOfObject('club:ntu', known)).toBe('ntu')
    expect(requestClubId(new Request('https://example.org/ws?club=ntu'), known)).toBe('ntu')
    expect(requestClubId(new Request('https://example.org/api/me', { headers: { [CLUB_HEADER]: 'ntu' } }), known)).toBe('ntu')
  })

  it('reads a club object’s club from its name, whatever is served now', () => {
    expect(clubOfClubObject('club')).toBe('tku')
    expect(clubOfClubObject(undefined)).toBe('tku')
    expect(clubOfClubObject('club:ntu')).toBe('ntu')
  })

  it('reads a table’s or an event’s club from its name: none is 淡江', () => {
    expect(clubOfScopedName('abc123')).toBe('tku')
    expect(clubOfScopedName('challenge:c1')).toBe('tku')
    expect(clubOfScopedName(undefined)).toBe('tku')
    expect(clubOfScopedName('ntu/abc123')).toBe('ntu')
    expect(clubOfScopedName('ntu/pairs:p1')).toBe('ntu')
  })

  it('keeps 淡江’s R2 keys as they were, another club’s under clubs/<id>/', () => {
    expect(clubStoragePrefix('tku')).toBe('')
    expect(clubStoragePrefix('ntu')).toBe('clubs/ntu/')
  })
})
