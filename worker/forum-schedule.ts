import type { Board, Post } from '../shared/forum.ts'
import type { Me } from '../shared/protocol.ts'
import type { ForumService } from './forum.ts'
import { moderatesForum } from './roles.ts'

/**
 * Scheduled forum posts (the table's e13-t12, ARCHITECTURE.md §5.19): each one waits in the club's
 * one scheduler (`worker/scheduler.ts`, the Durable Object's alarm) until its time, then comes out
 * and is told about as a new post is (`published`, club.ts: forum-notices.ts `posted`). The time is
 * kept in the post's row (`forum_posts.publish_at`), never only in memory: jobs are not stored, so
 * `load()` schedules every waiting post again when the object wakes (one whose time passed while it
 * slept comes out at once), and a post moved to another time leaves its old job with nothing to do.
 *
 * At its time the author must still be a member and an officer (who alone schedule posts, and post
 * on an officers-only board); otherwise the post goes back to being their draft.
 * Nothing here touches Cloudflare: the scheduler, the forum and the members come in as `deps`.
 */
export interface ForumScheduleDeps {
  forum: ForumService
  /** Runs `run` at `at` (ms), unless a job with the same key is waiting (ClubService `scheduleAt`) */
  at: (key: string, at: number, run: () => Promise<void>) => void
  /** The member as they are now; none when they are no longer a member */
  member: (userId: string) => Me | undefined
  /** A post came out at its time: tell the members (club.ts) */
  published: (author: Me, post: Post, board: Board) => Promise<void>
}

export class ForumSchedule {
  private readonly deps: ForumScheduleDeps

  constructor(deps: ForumScheduleDeps) {
    this.deps = deps
  }

  /** Every waiting post, again (after the object wakes, or a backup was restored) */
  load() {
    for (const { id, publishAt } of this.deps.forum.scheduled()) this.add(id, publishAt)
  }

  /** A post was saved: if it waits for a time now, that time gets a job */
  saved(post: Post) {
    if (post.publishAt !== undefined && !post.draft) this.add(post.id, post.publishAt)
  }

  /** The job for one post and time; the key carries both, so a new time is a new job */
  private add(id: string, at: number) {
    this.deps.at(`forum:${id}:${at}`, at, () => this.due(id, at))
  }

  /** The time came: out, and told, unless the post moved on (published, deleted, a draft, another time) */
  async due(id: string, at: number) {
    let author: Me | undefined
    const post = this.deps.forum.publishScheduled(id, at, (authorId) => {
      author = this.deps.member(authorId)
      return !!author && moderatesForum(author)
    })
    if (post && author) await this.deps.published(author, post, this.deps.forum.board(post.boardId))
  }
}
