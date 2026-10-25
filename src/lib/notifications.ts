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
    case 'boardFeatured':
      return t.notificationTexts[n.kind](name)
    case 'challengeReminder':
    case 'challengeResults':
      return t.notificationTexts[n.kind]()
    case 'tableInvited':
      return t.notificationTexts.tableInvited(name, Number(n.params.number ?? 0))
  }
}

/**
 * Where a notification leads when clicked: an invitation to the challenge lobby, where it is
 * answered (`e7-t16`); the other challenge news to that challenge's page (`e7-t18`); an invitation
 * to a table to that table; a featured board to its record, where the explanation is shown
 */
export function notificationLink(n: Notification): string {
  switch (n.kind) {
    case 'application':
      return '/admin'
    case 'friendOnline':
      return '/'
    case 'challengeInvited':
      return '/challenges'
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengeCancelled':
    case 'challengeReminder':
    case 'challengeResults':
      return n.params.challengeId ? `/challenges/${encodeURIComponent(String(n.params.challengeId))}` : '/challenges'
    case 'tableInvited':
      return n.params.tableId ? `/table/${encodeURIComponent(String(n.params.tableId))}` : '/'
    case 'boardFeatured':
      return n.params.boardId ? `/history/${encodeURIComponent(String(n.params.boardId))}` : '/featured'
  }
}
