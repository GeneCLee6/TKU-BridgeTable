import type { Notification } from '../../shared/protocol.ts'
import type { Strings } from '../strings.ts'

/** What a notification says, in the viewer's language */
export function notificationText(t: Strings, n: Notification): string {
  switch (n.kind) {
    case 'application':
      return t.notificationTexts.application(String(n.params.username ?? ''))
  }
}

/** Where a notification leads when clicked */
export function notificationLink(n: Notification): string {
  switch (n.kind) {
    case 'application':
      return '/admin'
  }
}
