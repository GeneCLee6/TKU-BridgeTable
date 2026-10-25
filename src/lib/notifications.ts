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

/**
 * Where a notification leads when clicked: an invitation to the challenge lobby, where it is
 * answered (`e7-t16`); the other challenge news to that challenge's page (`e7-t18`)
 */
export function notificationLink(n: Notification): string {
  switch (n.kind) {
    case 'application':
      return '/admin'
    case 'challengeInvited':
      return '/challenges'
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengeCancelled':
    case 'challengeReminder':
    case 'challengeResults':
      return n.params.challengeId ? `/challenges/${encodeURIComponent(String(n.params.challengeId))}` : '/challenges'
  }
}
