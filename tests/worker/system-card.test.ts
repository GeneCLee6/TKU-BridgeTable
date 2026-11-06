// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import clubCard from 'virtual:system-card-tku'
import publicCard from 'virtual:system-card-gib'
import { TKU_CARD_API, type Me } from '../../shared/protocol.ts'
import { cardRows, clubOnlyRows, normalized, rowsIn } from '../../shared/robot/system/card-leaks.ts'
import { deriveCard } from '../../shared/robot/system/card.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { ClubError } from '../../worker/errors.ts'
import { tkuCardResponse } from '../../worker/system-card.ts'

/** The club's system card is for signed-in members of 淡江 only (e5-t52, ARCHITECTURE.md §4) */

const member = { id: 'amy', username: 'amy', permissions: [] } as unknown as Me

/** What the route answers, or the error a request ends in */
function answer(method: string, clubId: string, user: Me | null, path = TKU_CARD_API) {
  try {
    return tkuCardResponse(method, path, clubId, user, clubCard)
  } catch (error) {
    return error
  }
}

describe('who gets the club’s card', () => {
  it('a signed-in member of 淡江 gets it, never cached by anyone else', async () => {
    const response = answer('GET', 'tku', member) as Response
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(deriveCard(TKU))))
  })

  it('the signed-out, other clubs and other methods all get the same not-found', () => {
    const answers = [answer('GET', 'tku', null), answer('GET', 'ntu', member), answer('GET', 'ntu', null), answer('POST', 'tku', member)]
    for (const refused of answers) {
      expect(refused).toBeInstanceOf(ClubError)
      expect(refused).toMatchObject({ code: 'noSuchApi', status: 404 })
    }
  })

  it('leaves every other path alone', () => {
    expect(answer('GET', 'tku', member, '/api/me')).toBeNull()
  })

  it('is checked before the sign-in check, so the signed-out get the same answer as other clubs', () => {
    const club = readFileSync('worker/club.ts', 'utf8')
    const route = club.indexOf('tkuCardResponse(request.method')
    const gate = club.indexOf("if (!user) throw new ClubError('signInFirst'")
    expect(route).toBeGreaterThan(0)
    expect(route).toBeLessThan(gate)
  })

  it('sends the card as built: nothing is derived in a request', () => {
    const source = readFileSync('worker/system-card.ts', 'utf8')
    expect(source).not.toMatch(/deriveCard|shared\/robot/)
    expect(JSON.parse(clubCard)).toEqual(JSON.parse(JSON.stringify(deriveCard(TKU))))
  })
})

describe('nothing of the club’s card in the public assets', () => {
  const club = deriveCard(TKU)
  const open = deriveCard(GIB)
  const rows = clubOnlyRows(club, open)

  it('the browser never imports the club’s module', () => {
    expect(publicCard.system).toBe('gib')
    expect(JSON.stringify(publicCard)).not.toContain('nameZh')
    const browser = readFileSync('src/lib/systemCards.ts', 'utf8')
    expect(browser).not.toContain('virtual:system-card-tku')
    expect(browser).toContain('virtual:system-card-gib')
  })

  it('has plenty of rows only the club’s card says', () => {
    expect(rows.length).toBeGreaterThan(100)
    expect(rows.some((row) => row.includes('oneMajorWeakTwo'))).toBe(true)
    expect(rows.some((row) => row.includes('nameZh'))).toBe(true)
    for (const row of cardRows(open)) expect(rows).not.toContain(row)
  })

  it('finds a row however the build wrote it: JSON, minified or in a string', () => {
    const row = club.sections[0].groups[0].calls.find((c) => c.call === '2D')!
    expect(row.shows.name).toBe('oneMajorWeakTwo')
    const asJson = JSON.stringify(row)
    const minified = asJson.replace(/"(\w+)":/g, '$1:')
    const inString = JSON.stringify(asJson)
    for (const text of [asJson, minified, inString]) expect(rowsIn(rows, [`var a=[${text}];`])).toContain(normalized(asJson))
    // A minifier's `!0` for `true`
    const readOnly = club.sections.flatMap((s) => s.groups.flatMap((g) => g.calls)).find((c) => c.readOnly && rows.includes(normalized(JSON.stringify(c))))!
    const shortened = JSON.stringify(readOnly).replace(/"(\w+)":/g, '$1:').replace(/true/g, '!0')
    expect(rowsIn(rows, [shortened])).toContain(normalized(JSON.stringify(readOnly)))
  })

  it('finds nothing in the 2/1 card, so shipping that is fine', () => {
    expect(rowsIn(rows, [JSON.stringify(publicCard)])).toEqual([])
  })
})
