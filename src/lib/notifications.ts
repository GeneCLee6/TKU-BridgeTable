import type { Notification } from '../../shared/protocol.ts'
import type { Strings } from '../strings.ts'

// Where a notification leads is decided in shared/ so the server's push (e1-t28) leads to the same page
export { notificationLink } from '../../shared/notification-link.ts'

/** What a notification says, in the viewer's language */
export function notificationText(t: Strings, n: Notification): string {
  const name = String(n.params.username ?? '')
  switch (n.kind) {
    case 'application':
    case 'passwordResetRequested':
    case 'challengeInvited':
    case 'challengeAccepted':
    case 'challengeDeclined':
    case 'challengePartnerDeclined':
    case 'challengePartnerSeated':
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
    case 'directorCalled':
      return t.notificationTexts[n.kind](name, Number(n.params.number ?? 0))
    case 'filesNearlyFull':
      return t.notificationTexts.filesNearlyFull(Number(n.params.gb ?? 0))
    case 'bookPublished':
    case 'bookReviewRequested':
    case 'bookReturned':
    case 'bookSuggestUnify':
      return t.notificationTexts[n.kind](name, String(n.params.name ?? n.params.slug ?? ''))
    case 'articleReviewRequested':
    case 'articleReturned':
    case 'articlePublished':
      return t.notificationTexts[n.kind](name, String(n.params.title ?? n.params.slug ?? ''))
    case 'bookOverrideChanged':
      return t.notificationTexts.bookOverrideChanged(String(n.params.name ?? n.params.slug ?? ''), String(n.params.profile ?? ''))
    case 'forumReply':
    case 'forumMention':
    case 'forumAnnouncement':
    case 'forumPinned':
      return t.notificationTexts[n.kind](name, String(n.params.title ?? ''))
    case 'forumHidden':
    case 'forumUnhidden':
      return t.notificationTexts[n.kind](String(n.params.title ?? ''))
    case 'tournamentAnnounced':
    case 'tournamentPartner':
    case 'tournamentWithdrawn':
    case 'tournamentRemoved':
    case 'tournamentCancelled':
    case 'tournamentDayReminder':
    case 'tournamentReminder':
    case 'tournamentResults':
      return t.notificationTexts[n.kind](name, String(n.params.title ?? ''))
  }
}
