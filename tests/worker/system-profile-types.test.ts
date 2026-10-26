import { describe, expect, it } from 'vitest'
import {
  CLUB_PROFILE_ID,
  isProfileScope,
  PROFILE_LIMITS,
  PROFILE_SCOPES,
  PROFILE_VISIBILITIES,
  type ProfileInput,
  type ProfileNote,
  type ProfileOverride,
  type ProfileRevision,
  type ProfileSummary,
  type SystemProfile,
} from '../../shared/protocol.ts'

/**
 * The system profile types are mirrored in TKU-BridgeBook src/lib/api.ts, which has the same test
 * (tests/lib/profileTypes.test.ts). The key lists and the sample below are identical in both
 * repos: a field added on one side fails that side's test until the list, and the other repo, are
 * updated too.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assertType = <T extends true>(value: T) => value

const PROFILE_KEYS = ['id', 'name', 'scope', 'parentId', 'visibility', 'adopted', 'overrides', 'notes', 'version', 'updatedAt', 'updatedBy'] as const
const NOTE_KEYS = ['slug', 'sectionId', 'text', 'by', 'at'] as const
const ROW_KEYS = ['kind', 'slug', 'sectionId', 'blockIndex', 'rowIndex', 'meaning', 'note'] as const
const SECTION_KEYS = ['kind', 'slug', 'sectionId', 'section'] as const
const META_KEYS = ['kind', 'slug', 'summary', 'tags'] as const
const SUMMARY_KEYS = ['id', 'name', 'scope', 'parentId', 'visibility', 'version', 'updatedAt', 'updatedBy', 'counts'] as const
const COUNT_KEYS = ['adopted', 'overrides', 'notes'] as const
const REVISION_KEYS = ['profileId', 'version', 'at', 'by', 'note', 'profile'] as const
const INPUT_KEYS = ['name', 'scope', 'parentId', 'visibility', 'adopted', 'overrides', 'notes'] as const

type Kind<K extends ProfileOverride['kind']> = Extract<ProfileOverride, { kind: K }>

const SAMPLE = {
  id: 'p-pair',
  name: '小明＋小華',
  scope: 'partnership',
  parentId: 'p-team',
  visibility: 'members',
  adopted: { lebensohl: 'off', bergen: 'on' },
  overrides: [
    { kind: 'row', slug: 'stayman', sectionId: 'responses', blockIndex: 0, rowIndex: 1, meaning: '4♥', note: '' },
    { kind: 'section', slug: 'stayman', sectionId: 'garbage', section: { id: 'garbage', title: '垃圾 Stayman' } },
    { kind: 'meta', slug: 'bergen', summary: '我們打反 Bergen', tags: ['反'] },
  ],
  notes: [{ slug: 'stayman', sectionId: 'responses', text: '記得問', by: 'u1', at: 1 }],
  version: 3,
  updatedAt: 1_700_000_000_000,
  updatedBy: 'u1',
} satisfies SystemProfile

describe('system profile types (mirrored in TKU-BridgeBook)', () => {
  it('have the same fields on both sides', () => {
    assertType<Equal<keyof SystemProfile, (typeof PROFILE_KEYS)[number]>>(true)
    assertType<Equal<keyof ProfileNote, (typeof NOTE_KEYS)[number]>>(true)
    assertType<Equal<keyof Kind<'row'>, (typeof ROW_KEYS)[number]>>(true)
    assertType<Equal<keyof Kind<'section'>, (typeof SECTION_KEYS)[number]>>(true)
    assertType<Equal<keyof Kind<'meta'>, (typeof META_KEYS)[number]>>(true)
    assertType<Equal<ProfileOverride['kind'], 'row' | 'section' | 'meta'>>(true)
    assertType<Equal<SystemProfile['adopted'][string], 'on' | 'off'>>(true)
    assertType<Equal<keyof ProfileSummary, (typeof SUMMARY_KEYS)[number]>>(true)
    assertType<Equal<keyof ProfileSummary['counts'], (typeof COUNT_KEYS)[number]>>(true)
    assertType<Equal<keyof ProfileRevision, (typeof REVISION_KEYS)[number]>>(true)
    assertType<Equal<keyof ProfileInput, (typeof INPUT_KEYS)[number]>>(true)
    expect(Object.keys(SAMPLE).sort()).toEqual([...PROFILE_KEYS].sort())
  })

  it('share the constants', () => {
    expect(CLUB_PROFILE_ID).toBe('club')
    expect(PROFILE_SCOPES).toEqual(['club', 'team', 'partnership'])
    expect(PROFILE_VISIBILITIES).toEqual(['club', 'members'])
    expect(PROFILE_LIMITS).toEqual({ bytesMax: 200_000, overridesMax: 500, profilesMax: 100, nameMax: 40, noteMax: 2_000 })
    expect(PROFILE_SCOPES.every(isProfileScope)).toBe(true)
    expect(isProfileScope('pair')).toBe(false)
    expect(isProfileScope(undefined)).toBe(false)
  })

  it('survive a JSON round trip', () => {
    expect(JSON.parse(JSON.stringify(SAMPLE))).toEqual(SAMPLE)
  })
})
