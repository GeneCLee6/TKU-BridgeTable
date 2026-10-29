// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { SEED_TOKEN_MIN, seedTokenMatches } from '../../worker/book-seed.ts'

const secret = 'x'.repeat(SEED_TOKEN_MIN)
const request = (authorization?: string) =>
  new Request('https://table.example/api/book/builtin', { method: 'PUT', headers: authorization ? { Authorization: authorization } : {} })

describe('the built-in conventions seed token (BridgeHall L0)', () => {
  it('accepts only the exact bearer token', async () => {
    expect(await seedTokenMatches(request(`Bearer ${secret}`), secret)).toBe(true)
    expect(await seedTokenMatches(request(`Bearer ${secret}y`), secret)).toBe(false)
    expect(await seedTokenMatches(request(secret), secret)).toBe(false)
    expect(await seedTokenMatches(request(), secret)).toBe(false)
  })

  it('accepts nothing without the secret, or with one too short to be safe', async () => {
    expect(await seedTokenMatches(request('Bearer '), undefined)).toBe(false)
    expect(await seedTokenMatches(request('Bearer short'), 'short')).toBe(false)
  })
})
