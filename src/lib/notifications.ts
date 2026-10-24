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
      return t.notificationTexts[n.kind](name)
    case 'challengeReminder':
    case 'challengeResults':
      return t.notificationTexts[n.kind]()
  }
}

/** Where a notification leads when clicked; the challenge pages come with C6 (`e7-t16`), the lobby until then */
export function notificationLink(n: Notification): string {
  switch (n.kind) {
    case 'application':
      return '/admin'
    case 'challengeInvited':
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengeCancelled':
    case 'challengeReminder':
    case 'challengeResults':
      return '/'
  }
}
