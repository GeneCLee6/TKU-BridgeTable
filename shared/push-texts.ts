import type { Lang } from './messages.ts'
import { clubPath, DEFAULT_CLUB_ID } from './clubs.ts'
import { notificationLink } from './notification-link.ts'
import type { Notification, NotificationKind } from './protocol.ts'
import { PUSH_TEXTS } from './push-texts.generated.ts'

/**
 * What a push notification says (e1-t28, ARCHITECTURE.md §5.4). The bell builds its texts in the
 * browser from src/strings.ts, which is far too big for the Worker; a push is shown by the service
 * worker with no page open, so the server writes the text itself. `push-texts.generated.ts` holds
 * the same texts as templates (`{username}`, `{number}`…), made from strings.ts by
 * `npm run push:texts`; a test checks the two still say the same thing in every language.
 */

/** Per language: the notification's title (the site's name), the test push, and each kind's template */
export type PushTexts = Record<Lang, { title: string; test: string; kinds: Record<NotificationKind, string> }>

/** What the service worker gets (encrypted) and shows */
export interface PushMessage {
  title: string
  body: string
  /** Where clicking it leads: a path on this site, or a page of TKU BridgeBook */
  url: string
  /** The notification's id: the same notification shown twice replaces itself */
  tag: string
}

/** Longest body a push carries; the encrypted message must stay well under the push services' 4 KB */
export const PUSH_BODY_MAX = 300

const mark = (key: string) => `⟦${key}⟧`
/** Unlikely numbers the generator puts in, to find where a template's numbers go */
const NUMBER_MARKS: Record<string, number> = { number: 987_654_321, gb: 123_456_789 }

/** The parameters the generator renders every text with: each one becomes its placeholder */
export const PUSH_SAMPLE: Notification['params'] = {
  username: mark('username'),
  name: mark('name'),
  title: mark('title'),
  profile: mark('profile'),
  ...NUMBER_MARKS,
}

/** A text rendered with PUSH_SAMPLE, as a template */
export function pushTemplateOf(text: string): string {
  let template = text.replace(/⟦(\w+)⟧/g, (_, key: string) => `{${key}}`)
  for (const [key, value] of Object.entries(NUMBER_MARKS)) template = template.split(String(value)).join(`{${key}}`)
  return template
}

/** Fills a template's placeholders; text inside the values is never read as a placeholder */
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

const clip = (text: string) => (text.length > PUSH_BODY_MAX ? `${text.slice(0, PUSH_BODY_MAX - 1)}…` : text)

/**
 * A notification as a push in `lang`: the same text as the bell and the same page when clicked, in
 * the member's own club (`clubId`, e12-t04: another club's pages are under `/c/<id>/`)
 */
export function pushMessage(n: Notification, lang: Lang, options: { forum?: boolean; clubId?: string } = {}): PushMessage {
  const texts = PUSH_TEXTS[lang] ?? PUSH_TEXTS.zh
  const p = n.params
  const str = (value: unknown) => (value === undefined || value === null ? '' : String(value))
  const values = {
    username: str(p.username),
    name: str(p.name ?? p.slug),
    // The library's articles fall back to their slug, as the bell does; the forum's posts do not
    title: str(p.title ?? (n.kind.startsWith('article') ? p.slug : undefined)),
    profile: str(p.profile),
    number: String(Number(p.number ?? 0)),
    gb: String(Number(p.gb ?? 0)),
  }
  return { title: texts.title, body: clip(fill(texts.kinds[n.kind] ?? '', values)), url: clubPath(options.clubId ?? DEFAULT_CLUB_ID, notificationLink(n, options)), tag: n.id }
}

/** The test push from "My account" */
export function testPushMessage(lang: Lang, clubId: string = DEFAULT_CLUB_ID): PushMessage {
  const texts = PUSH_TEXTS[lang] ?? PUSH_TEXTS.zh
  return { title: texts.title, body: texts.test, url: clubPath(clubId, '/account'), tag: 'push-test' }
}
