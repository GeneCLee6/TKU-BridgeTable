// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { CLUB_HEADER, CLUB_IDS, clubIdOfObject, clubObjectName, DEFAULT_CLUB_ID, requestClubId } from '../../shared/clubs.ts'

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
