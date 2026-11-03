// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { FORUM_LIMITS, type Board, type Post, type PostBlock } from '../../shared/forum.ts'
import type { Me, Notification, NotificationKind } from '../../shared/protocol.ts'
import { ForumService } from '../../worker/forum.ts'
import { ForumNotices } from '../../worker/forum-notices.ts'
import { ForumSchedule } from '../../worker/forum-schedule.ts'
import { forumRouteNeed } from '../../worker/roles.ts'
import { AlarmQueue } from '../../worker/scheduler.ts'
import type { Sql } from '../../worker/store.ts'
import { memorySql } from './sqlite.ts'

/** Drafts and scheduled posts (e13-t12, AC-13.4; ARCHITECTURE.md §5.19 「公告與新聞的編輯流程」) */

const me = (id: string, permissions: Me['permissions'] = [], admin = false): Me => ({
  id,
  username: id,
  admin,
  permissions,
})
const boss = me('boss', [], true)
const cat = me('cat', ['forumModerate'])
const amy = me('amy')
const ben = me('ben')
const MEMBERS = [
  { id: 'amy', username: 'amy' },
  { id: 'ben', username: 'ben' },
  { id: 'cat', username: 'cat' },
  { id: 'boss', username: 'boss' },
]
const HOUR = 3_600_000

let sql: Sql
let forum: ForumService
let time: number
let ids: number

beforeEach(() => {
  time = 1_000_000
  ids = 0
  sql = memorySql()
  forum = new ForumService(sql, {
    now: () => time,
    newId: () => `id${++ids}`,
    members: () => MEMBERS,
  })
  forum.createTables()
})

const para = (text: string): PostBlock => ({ kind: 'paragraph', text })
const ids_ = (posts: { id: string }[]) => posts.map((p) => p.id)
/** Writes as different members a minute apart so the rate limit stays out of the way */
const write = (who: Me, board: string, body: Record<string, unknown>) => {
  time += 60_000
  return forum.createPost(who, board, { blocks: [para('社課公告')], ...body })
}

describe('drafts (e13-t12)', () => {
  it('keeps a draft for its author only: in no list, search or tag count, and gone for everyone else', () => {
    const out = write(ben, 'chat', { title: '公開的', tags: ['社課'] })
    const draft = write(amy, 'chat', { title: '草稿', draft: true, tags: ['社課'] })
    expect(draft).toMatchObject({ draft: true })
    expect(draft.publishAt).toBeUndefined()

    for (const viewer of [amy, ben, boss]) {
      expect(ids_(forum.boardPage('chat', 1, viewer).posts)).toEqual([out.id])
      expect(ids_(forum.feed(1, {}, viewer).posts)).toEqual([out.id])
      expect(ids_(forum.feed(1, { author: 'amy' }, viewer).posts)).toEqual([])
      expect(forum.search('社課', 1, { viewer }).total).toBe(1)
      expect(forum.tags(viewer).tags).toEqual([{ tag: '社課', count: 1 }])
      expect(ids_(forum.latest(viewer).discussions)).toEqual([out.id])
    }
    expect(forum.thread(draft.id, amy).post.draft).toBe(true)
    // Not even an admin opens someone else's draft
    for (const viewer of [ben, cat, boss])
      expect(() => forum.thread(draft.id, viewer)).toThrow(
        expect.objectContaining({ code: 'postGone', status: 404 }),
      )
    expect(ids_(forum.unpublished(amy).posts)).toEqual([draft.id])
    expect(forum.unpublished(ben).posts).toEqual([])
    expect(forum.unpublished(boss).posts).toEqual([])
  })

  it('takes no comments, reactions, reports, pins or hiding before it is out', () => {
    const draft = write(amy, 'chat', { draft: true })
    const notOut = expect.objectContaining({ code: 'postNotPublished', status: 409 })
    expect(() => forum.addComment(amy, draft.id, { blocks: [para('x')] })).toThrow(notOut)
    expect(() => forum.react(amy, 'post', draft.id, { emoji: '👍' })).toThrow(notOut)
    expect(() => forum.setPinned(draft.id, { pinned: true })).toThrow(notOut)
    expect(() => forum.setHidden(boss, draft.id, { hidden: true })).toThrow(notOut)
    // Someone else is told it is not there at all
    expect(() => forum.addComment(ben, draft.id, { blocks: [para('x')] })).toThrow(
      expect.objectContaining({ code: 'postGone' }),
    )
    expect(() =>
      forum.fileReport(ben, { target: 'post', targetId: draft.id, reason: 'x' }),
    ).toThrow(expect.objectContaining({ code: 'postGone' }))
  })

  it('stays a draft through an edit that does not say otherwise, and comes out as a new post when published', () => {
    const draft = write(amy, 'chat', { draft: true })
    time += HOUR
    // A site without drafts (BridgeHall) sends title and blocks only: still a draft, not marked as edited
    const edited = forum.updatePost(amy, draft.id, { title: '改過', blocks: [para('第二版')] })
    expect(edited).toMatchObject({ draft: true, title: '改過', createdAt: time })
    expect(edited.editedAt).toBeUndefined()
    time += HOUR
    const out = forum.updatePost(amy, draft.id, {
      title: '改過',
      blocks: [para('第二版')],
      draft: false,
    })
    expect(out.draft).toBeUndefined()
    expect(out.createdAt).toBe(time)
    expect(out.editedAt).toBeUndefined()
    expect(ids_(forum.feed(1, {}, ben).posts)).toEqual([draft.id])
    expect(forum.unpublished(amy).posts).toEqual([])
    // Out stays out
    expect(() => forum.updatePost(amy, draft.id, { blocks: [para('x')], draft: true })).toThrow(
      expect.objectContaining({ code: 'badContent' }),
    )
    time += 60_000
    expect(
      forum.updatePost(amy, draft.id, { blocks: [para('第三版')], draft: false }).editedAt,
    ).toBe(time)
  })

  it('lets anyone who may post on a board keep drafts there, up to FORUM_LIMITS.draftsMax, and checks the field', () => {
    expect(() => write(amy, 'news', { draft: true })).toThrow(
      expect.objectContaining({ code: 'forumBoardOfficersOnly' }),
    )
    expect(() => write(amy, 'chat', { draft: 'yes' })).toThrow(
      expect.objectContaining({ code: 'badContent' }),
    )
    for (let i = 0; i < FORUM_LIMITS.draftsMax; i++) write(amy, 'chat', { draft: true })
    expect(() => write(amy, 'chat', { draft: true })).toThrow(
      expect.objectContaining({ code: 'forumDraftLimit', params: { max: FORUM_LIMITS.draftsMax } }),
    )
    // Posting straight out is not held up
    expect(write(amy, 'chat', {}).draft).toBeUndefined()
  })

  it('is deleted by its author like any post', () => {
    const draft = write(amy, 'chat', { draft: true })
    forum.deletePost(amy, draft.id)
    expect(forum.unpublished(amy).posts).toEqual([])
  })
})

describe('scheduled posts (e13-t12)', () => {
  it('lets only officers schedule, after now and at most FORUM_LIMITS.scheduleDaysMax days ahead', () => {
    expect(() => write(amy, 'chat', { publishAt: time + 2 * HOUR })).toThrow(
      expect.objectContaining({ code: 'forumScheduleOfficersOnly', status: 403 }),
    )
    expect(() => write(cat, 'news', { publishAt: time })).toThrow(
      expect.objectContaining({ code: 'forumScheduleTime', status: 400 }),
    )
    expect(() => write(cat, 'news', { publishAt: 'tomorrow' })).toThrow(
      expect.objectContaining({ code: 'forumScheduleTime' }),
    )
    expect(() =>
      write(cat, 'news', {
        publishAt: time + 60_000 + (FORUM_LIMITS.scheduleDaysMax + 1) * 24 * HOUR,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'forumScheduleTime',
        params: { days: FORUM_LIMITS.scheduleDaysMax },
      }),
    )
    expect(() => write(cat, 'news', { publishAt: time + 2 * HOUR, draft: true })).toThrow(
      expect.objectContaining({ code: 'badContent' }),
    )
    const post = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    expect(post.publishAt).toBe(time + HOUR)
    expect(post.draft).toBeUndefined()
  })

  it('shows a scheduled post to its author and the officers only, and in no list', () => {
    const post = write(cat, 'news', { title: '下週社課', publishAt: time + 60_000 + HOUR })
    const mine = write(cat, 'news', { title: '我的草稿', draft: true })
    expect(forum.latest(boss).news).toEqual([])
    expect(forum.boardPage('news', 1, cat).posts).toEqual([])
    expect(forum.thread(post.id, boss).post.publishAt).toBe(post.publishAt)
    expect(() => forum.thread(post.id, amy)).toThrow(expect.objectContaining({ code: 'postGone' }))
    // Officers see everyone's scheduled posts (not their drafts) to know what the club is about to hear
    expect(ids_(forum.unpublished(cat).posts)).toEqual([post.id, mine.id])
    expect(ids_(forum.unpublished(boss).posts)).toEqual([post.id])
    expect(forum.unpublished(amy).posts).toEqual([])
  })

  it('comes out at its time as if posted then, unless it moved on', () => {
    const post = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    const at = post.publishAt!
    expect(forum.scheduled()).toEqual([{ id: post.id, publishAt: at }])
    // Another time: the old job finds nothing to do
    time += 60_000
    const moved = forum.updatePost(cat, post.id, { blocks: [para('改時間')], publishAt: at + HOUR })
    expect(forum.publishScheduled(post.id, at, () => true)).toBeNull()
    time = at + HOUR
    const out = forum.publishScheduled(post.id, moved.publishAt!, () => true)!
    expect(out.publishAt).toBeUndefined()
    expect(out.createdAt).toBe(time)
    expect(ids_(forum.latest(amy).news)).toEqual([post.id])
    expect(forum.scheduled()).toEqual([])
    expect(forum.publishScheduled(post.id, moved.publishAt!, () => true)).toBeNull()
  })

  it('goes back to being a draft when its author may no longer schedule it', () => {
    const post = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    time = post.publishAt!
    expect(forum.publishScheduled(post.id, post.publishAt!, () => false)).toBeNull()
    expect(forum.thread(post.id, cat).post).toMatchObject({ draft: true })
    expect(forum.latest(amy).news).toEqual([])
  })

  it('can be put out now or turned back into a draft by its author', () => {
    const first = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    expect(
      forum.updatePost(cat, first.id, { blocks: [para('先存著')], draft: true }),
    ).toMatchObject({ draft: true })
    expect(forum.scheduled()).toEqual([])
    const second = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    time += 60_000
    const out = forum.updatePost(cat, second.id, { blocks: [para('現在發')], publishAt: null })
    expect(out.publishAt).toBeUndefined()
    expect(out.createdAt).toBe(time)
    // Someone else may not edit it, officer or not
    expect(() => forum.updatePost(boss, first.id, { blocks: [para('x')], draft: false })).toThrow(
      expect.objectContaining({ code: 'notYours' }),
    )
  })

  it('adds the columns to tables from before them, every old post out', () => {
    const old: Sql = memorySql()
    old.exec(`CREATE TABLE forum_posts (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, author_id TEXT NOT NULL, title TEXT, blocks TEXT NOT NULL,
      mentions TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER, pinned_at INTEGER,
      locked INTEGER NOT NULL DEFAULT 0, comment_count INTEGER NOT NULL DEFAULT 0, body_text TEXT,
      hidden_at INTEGER, hidden_by TEXT, tags TEXT)`)
    old.exec(
      "INSERT INTO forum_posts (id, board_id, author_id, blocks, mentions, created_at) VALUES ('old', 'chat', 'amy', ?, '[]', 1)",
      JSON.stringify([para('舊貼文')]),
    )
    const service = new ForumService(old, {
      now: () => time,
      newId: () => `id${++ids}`,
      members: () => MEMBERS,
    })
    service.createTables()
    const post = service.thread('old', ben).post
    expect(post.draft).toBeUndefined()
    expect(post.publishAt).toBeUndefined()
    expect(ids_(service.feed(1, {}, ben).posts)).toEqual(['old'])
  })

  it('has a route for members, and a board may not take its name', () => {
    expect(forumRouteNeed('GET', '/drafts')).toBe('member')
    expect(forumRouteNeed('POST', '/drafts')).toBeNull()
    expect(() => forum.createBoard({ id: 'drafts', name: '草稿' })).toThrow(
      expect.objectContaining({ code: 'badContent' }),
    )
  })
})

describe('ForumSchedule: the scheduled posts in the club’s scheduler (e13-t12)', () => {
  let queue: AlarmQueue
  let wakes: number[]
  let sent: { to: string; kind: NotificationKind; params: Notification['params'] }[]
  let members: typeof MEMBERS
  let officers: Set<string>

  const schedule = () => {
    const notices = new ForumNotices({
      notify: async (to, kind, params) => void sent.push({ to, kind, params }),
      members: () => members,
    })
    return new ForumSchedule({
      forum,
      at: (key, at, run) => queue.add(key, 'forum', Math.max(0, at - time), run),
      member: (id) =>
        members.some((m) => m.id === id)
          ? me(id, officers.has(id) ? ['forumModerate'] : [])
          : undefined,
      published: (author: Me, post: Post, board: Board) => notices.posted(author, post, board),
    })
  }

  beforeEach(() => {
    wakes = []
    sent = []
    members = [...MEMBERS]
    officers = new Set(['cat'])
    queue = new AlarmQueue(
      () => time,
      (at) => wakes.push(at),
    )
  })

  it('publishes at its time and tells every member as a new announcement', async () => {
    const forumSchedule = schedule()
    const post = write(cat, 'news', { title: '週五社課', publishAt: time + 60_000 + HOUR })
    forumSchedule.saved(post)
    expect(wakes).toEqual([post.publishAt])
    await queue.runDue()
    expect(sent).toEqual([])
    time = post.publishAt!
    await queue.runDue()
    expect(forum.latest(amy).news.map((p) => p.id)).toEqual([post.id])
    expect(sent.map((s) => `${s.to}:${s.kind}`).sort()).toEqual([
      'amy:forumAnnouncement',
      'ben:forumAnnouncement',
      'boss:forumAnnouncement',
    ])
    expect(sent[0].params).toEqual({ postId: post.id, title: '週五社課', username: 'cat' })
  })

  it('schedules every waiting post again after a wake-up, and publishes one whose time passed at once', async () => {
    const soon = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    const later = write(cat, 'news', { publishAt: time + 60_000 + 5 * HOUR })
    write(cat, 'news', { draft: true })
    // The object slept through the first one's time; a new object (fresh queue) loads them
    time = soon.publishAt! + HOUR
    schedule().load()
    expect(wakes).toEqual([time])
    await queue.runDue()
    expect(forum.latest(amy).news.map((p) => p.id)).toEqual([soon.id])
    time = later.publishAt!
    await queue.runDue()
    expect(forum.latest(amy).news.map((p) => p.id)).toEqual([later.id, soon.id])
  })

  it('leaves the old time with nothing to do when the post moves, and never publishes twice', async () => {
    const forumSchedule = schedule()
    const post = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    forumSchedule.saved(post)
    time += 60_000
    const moved = forum.updatePost(cat, post.id, {
      blocks: [para('延後')],
      publishAt: post.publishAt! + HOUR,
    })
    forumSchedule.saved(moved)
    time = post.publishAt!
    await queue.runDue()
    expect(forum.latest(amy).news).toEqual([])
    time = moved.publishAt!
    await queue.runDue()
    forumSchedule.load()
    await queue.runDue()
    expect(forum.latest(amy).news.map((p) => p.id)).toEqual([post.id])
    expect(sent.filter((s) => s.to === 'amy')).toHaveLength(1)
  })

  it('makes it a draft again, telling nobody, when the author is no longer an officer or a member', async () => {
    const forumSchedule = schedule()
    const first = write(cat, 'news', { publishAt: time + 60_000 + HOUR })
    const second = write(boss, 'news', { publishAt: time + 60_000 + HOUR })
    forumSchedule.saved(first)
    forumSchedule.saved(second)
    officers.delete('cat')
    members = members.filter((m) => m.id !== 'boss')
    time = second.publishAt!
    await queue.runDue()
    expect(sent).toEqual([])
    expect(forum.latest(amy).news).toEqual([])
    expect(forum.unpublished(cat).posts.map((p) => [p.id, p.draft])).toEqual([[first.id, true]])
  })

  it('does nothing for a draft or a post that is out', () => {
    schedule().saved(write(amy, 'chat', { draft: true }))
    schedule().saved(write(amy, 'chat', {}))
    expect(wakes).toEqual([])
  })
})
