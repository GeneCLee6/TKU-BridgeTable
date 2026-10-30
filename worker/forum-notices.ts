import type { Board, Comment, Post } from '../shared/forum.ts'
import type { ClubMember, Me, Notification, NotificationKind } from '../shared/protocol.ts'
import { postExcerpt } from './forum.ts'

/**
 * The forum's notifications in the club's notification centre (BridgeHall e11-t08, AC-11.5). Who
 * hears what, each about one post (`{ postId, title, username }`, `title` its title or the start of
 * its words; `commentId` too when it is about a comment):
 *
 * - `forumMention`: whoever a new post or comment names with `@`, and whoever an edit names that the
 *   text did not name before
 * - `forumReply`: a post's author when someone comments on it; a top comment's author when someone
 *   replies under it
 * - `forumAnnouncement`: every member, for a new post on an officers-only board (社團新聞)
 * - `forumPinned`: a post's author when an officer pins it
 *
 * Each member hears one thing about one post or comment, the most particular first (being named
 * over a reply over the news). Nobody hears about their own doing, nor someone who is no longer a
 * member. Sending is the caller's (club.ts `tell`): what was saved stays saved when it fails.
 */
export interface ForumNoticeDeps {
  notify: (userId: string, kind: NotificationKind, params: Notification['params']) => Promise<unknown>
  members: () => ClubMember[]
}

export class ForumNotices {
  private readonly deps: ForumNoticeDeps

  constructor(deps: ForumNoticeDeps) {
    this.deps = deps
  }

  /** A new post; `board` is the board it is on */
  async posted(actor: Me, post: Post, board: Pick<Board, 'postPolicy'>) {
    const tell = this.teller(actor, post)
    for (const userId of post.mentions ?? []) await tell(userId, 'forumMention')
    if (board.postPolicy === 'officers') for (const m of this.deps.members()) await tell(m.id, 'forumAnnouncement')
  }

  /** A new comment on `post`; `parent` is the top comment it replies under */
  async commented(actor: Me, post: Post, comment: Comment, parent?: Comment) {
    const tell = this.teller(actor, post, comment.id)
    for (const userId of comment.mentions ?? []) await tell(userId, 'forumMention')
    if (parent) await tell(parent.authorId, 'forumReply')
    await tell(post.authorId, 'forumReply')
  }

  /** An edited post or comment: only the members it names now and did not before */
  async edited(actor: Me, post: Post, before: readonly string[], comment?: Comment) {
    const tell = this.teller(actor, post, comment?.id)
    for (const userId of (comment ?? post).mentions ?? []) if (!before.includes(userId)) await tell(userId, 'forumMention')
  }

  /** An officer pinned a post */
  async pinned(actor: Me, post: Post) {
    await this.teller(actor, post)(post.authorId, 'forumPinned')
  }

  private teller(actor: Me, post: Post, commentId?: string) {
    const known = new Set(this.deps.members().map((m) => m.id))
    const told = new Set<string>([actor.id])
    const params: Notification['params'] = { postId: post.id, title: postExcerpt(post), username: actor.username }
    if (commentId) params.commentId = commentId
    return async (userId: string, kind: NotificationKind) => {
      if (told.has(userId) || !known.has(userId)) return
      told.add(userId)
      await this.deps.notify(userId, kind, params)
    }
  }
}
