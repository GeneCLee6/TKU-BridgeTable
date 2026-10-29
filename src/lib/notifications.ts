import { BOOK_SITE } from '../../shared/book-site.ts'
import type { Notification } from '../../shared/protocol.ts'
import type { Strings } from '../strings.ts'

/** What a notification says, in the viewer's language */
export function notificationText(t: Strings, n: Notification): string {
  const name = String(n.params.username ?? '')
  switch (n.kind) {
    case 'application':
    case 'challengeInvited':
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengeCancelled':
    case 'friendOnline':
    case 'matchInvited':
    case 'matchAccepted':
    case 'matchDeclined':
    case 'matchLeft':
    case 'matchRemoved':
    case 'matchCancelled':
    case 'matchStarted':
    case 'matchAbandoned':
    case 'matchSubIn':
    case 'boardFeatured':
    case 'pairInvited':
    case 'pairAccepted':
    case 'pairDeclined':
    case 'pairEnded':
      return t.notificationTexts[n.kind](name)
    case 'challengeReminder':
    case 'challengeResults':
    case 'challengeWeekly':
    case 'matchFinished':
      return t.notificationTexts[n.kind]()
    case 'tableInvited':
    case 'tableRequest':
    case 'tableRequestApproved':
    case 'tableRequestDeclined':
      return t.notificationTexts[n.kind](name, Number(n.params.number ?? 0))
    case 'filesNearlyFull':
      return t.notificationTexts.filesNearlyFull(Number(n.params.gb ?? 0))
  }
}

/**
 * Where a notification leads when clicked: challenge news, an invitation too, to that challenge's
 * page, where it is answered and played (`e7-t16`, `e7-t18`); an invitation
 * to a table, a request to join one and its answer to that table; a featured board to its record, where the explanation is shown; team
 * match news to the match's prep room (`e8-t06`), except being taken off a seat, after which only
 * the list of one's matches is left; partnership news to the partnership's page in TKU BridgeBook
 * (an address on another site, which the bell opens as a page load); the files nearly full to
 * TKU BridgeHall's e-books, where the largest files are (BridgeHall e5-t15)
 */
export function notificationLink(n: Notification): string {
  switch (n.kind) {
    case 'application':
      return '/admin'
    case 'friendOnline':
      return '/'
    case 'challengeInvited':
    case 'challengeWeekly':
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengeCancelled':
    case 'challengeReminder':
    case 'challengeResults':
      return n.params.challengeId ? `/challenges/${encodeURIComponent(String(n.params.challengeId))}` : '/challenges'
    case 'tableInvited':
    case 'tableRequest':
    case 'tableRequestApproved':
    case 'tableRequestDeclined':
      return n.params.tableId ? `/table/${encodeURIComponent(String(n.params.tableId))}` : '/'
    case 'matchRemoved':
      return '/matches'
    case 'matchInvited':
    case 'matchAccepted':
    case 'matchDeclined':
    case 'matchLeft':
    case 'matchCancelled':
    case 'matchStarted':
    case 'matchFinished':
    case 'matchAbandoned':
    case 'matchSubIn':
      return n.params.matchId ? `/matches/${encodeURIComponent(String(n.params.matchId))}` : '/matches'
    case 'boardFeatured':
      return n.params.boardId ? `/history/${encodeURIComponent(String(n.params.boardId))}` : '/featured'
    case 'pairInvited':
    case 'pairAccepted':
    case 'pairDeclined':
    case 'pairEnded':
      return n.params.pairId ? `${BOOK_SITE}/pairs/${encodeURIComponent(String(n.params.pairId))}` : BOOK_SITE
    case 'filesNearlyFull':
      return `${BOOK_SITE}/library/book`
  }
}
