import type { BookNote } from './auction.ts'
import { CLUB_PROFILE_ID } from './protocol.ts'

/** Where TKU BridgeHall (淡江橋館) is published, and the address of one of its pages */
export const BOOK_SITE = 'https://tku-bridge-hall.vercel.app'

/**
 * A convention's page, at one of its sections, read with a system profile (BridgeHall e7-t05):
 * /c/:slug/:sectionId?profile=<id>. The handbook opens the profile only for a reader who may read
 * it (the club's, the default, is left out), and sends a signed-out reader through its login page and back (`?next=`)
 */
export function bookUrl(slug: string, sectionId?: string, profile?: string): string {
  const path = `${BOOK_SITE}/c/${encodeURIComponent(slug)}${sectionId ? `/${encodeURIComponent(sectionId)}` : ''}`
  return profile && profile !== CLUB_PROFILE_ID ? `${path}?profile=${encodeURIComponent(profile)}` : path
}

/** The handbook's section a call's words come from (`AuctionCall.book`) */
export const bookNoteUrl = (note: BookNote) => bookUrl(note.slug, note.sectionId, note.profile)
