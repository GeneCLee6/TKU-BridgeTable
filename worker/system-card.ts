import { DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import { TKU_CARD_API, type Me } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'

/**
 * The club's system card (e5-t52, ARCHITECTURE.md §4): for signed-in members of 淡江 only. The
 * signed-out and other clubs get one and the same not-found answer. The card itself was worked out at build time and is sent as it is: no derivation and no JSON work here.
 */
export function tkuCardResponse(method: string, pathname: string, clubId: string, user: Me | null, card: string): Response | null {
  if (pathname !== TKU_CARD_API) return null
  if (method !== 'GET' || clubId !== DEFAULT_CLUB_ID || !user) throw new ClubError('noSuchApi', {}, 404)
  return new Response(card, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' },
  })
}
