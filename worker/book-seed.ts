/**
 * The built-in conventions' seed token (BridgeHall L0, e10-t20). BridgeHall's private repository
 * holds the club's built-in conventions and sends them here with its scripts/seed-builtin.ts, which
 * signs in with this token instead of an account: `Authorization: Bearer <BOOK_SEED_TOKEN>`.
 * The token only reaches `/api/book/builtin` (seeding, and reading back every built-in convention
 * to compare with the source) and `GET /api/book/search-index`; an admin's session reaches them too. Without the secret, or with one
 * shorter than SEED_TOKEN_MIN, no token is accepted (DEPLOY.md §4.10).
 */

export const SEED_TOKEN_MIN = 32
const encoder = new TextEncoder()

const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))

/** True when the request carries the seed token; compares digests in constant time */
export async function seedTokenMatches(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret || secret.length < SEED_TOKEN_MIN) return false
  const header = request.headers.get('Authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const [given, wanted] = await Promise.all([digest(header.slice('Bearer '.length).trim()), digest(secret)])
  let diff = 0
  for (let i = 0; i < wanted.length; i++) diff |= given[i] ^ wanted[i]
  return diff === 0
}
