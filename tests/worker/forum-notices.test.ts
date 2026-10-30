// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { PostBlock } from '../../shared/forum.ts'
import type { Me, Notification, NotificationKind } from '../../shared/protocol.ts'
import { ForumService } from '../../worker/forum.ts'
import { ForumNotices } from '../../worker/forum-notices.ts'
import { BOOK_SITE } from '../../shared/book-site.ts'
import { notificationLink } from '../../src/lib/notifications.ts'
import { memorySql } from './sqlite.ts'

const me = (id: string, admin = false): Me => ({ id, username: id, admin, permissions: [] })
const boss = me('boss', true)
const amy = me('amy')
const ben = me('ben')
const cat = me('cat')
const MEMBERS = [
  { id: 'amy', username: 'amy', displayName: '艾咪' },
  { id: 'ben', username: 'ben' },
  { id: 'cat', username: 'cat' },
  { id: 'boss', username: 'boss' },
]
let members = [...MEMBERS]

let forum: ForumService
let notices: ForumNotices
let sent: { to: string; kind: NotificationKind; params: Notification['params'] }[]
let time: number

beforeEach(() => {
  time = 1_000_000
  let ids = 0
  members = [...MEMBERS]
  forum = new ForumService(memorySql(), { now: () => (time += 60_000), newId: () => `id${++ids}`, members: () => members })
  forum.createTables()
  sent = []
  notices = new ForumNotices({
    notify: async (to, kind, params) => sent.push({ to, kind, params }),
    members: () => members,
  })
})

const para = (text: string): PostBlock => ({ kind: 'paragraph', text })
const kinds = () => sent.map((s) => `${s.to}:${s.kind}`).sort()

describe('forum notifications (e11-t08, AC-11.5)', () => {
  it('a new post tells whoever it names, and news tells every member once', async () => {
    const post = forum.createPost(amy, 'deals', { title: '第三副', blocks: [para('@ben 和 @艾咪 看這副')] })
    await notices.posted(amy, post, forum.board('deals'))
    expect(sent).toEqual([{ to: 'ben', kind: 'forumMention', params: { postId: post.id, title: '第三副', username: 'amy' } }])

    sent = []
    const news = forum.createPost(boss, 'news', { blocks: [para('週五社課改到 @cat 的教室')] })
    await notices.posted(boss, news, forum.board('news'))
    expect(kinds()).toEqual(['amy:forumAnnouncement', 'ben:forumAnnouncement', 'cat:forumMention'])
    expect(sent[0].params.title).toBe('週五社課改到 @cat 的教室')
  })

  it('a comment tells the post’s author, a reply its top comment’s too, and whoever it names, each once', async () => {
    const post = forum.createPost(amy, 'deals', { blocks: [para('一副牌')] })
    const top = forum.addComment(ben, post.id, { blocks: [para('好牌')] })
    await notices.commented(ben, post, top)
    expect(sent).toEqual([{ to: 'amy', kind: 'forumReply', params: { postId: post.id, title: '一副牌', username: 'ben', commentId: top.id } }])

    sent = []
    const reply = forum.addComment(cat, post.id, { parentId: top.id, blocks: [para('@amy 同意')] })
    await notices.commented(cat, post, reply, forum.comment(top.id))
    expect(kinds()).toEqual(['amy:forumMention', 'ben:forumReply'])

    sent = []
    const own = forum.addComment(amy, post.id, { blocks: [para('謝謝')] })
    await notices.commented(amy, post, own)
    expect(sent).toEqual([])
  })

  it('an edit tells only whoever it names now and did not before', async () => {
    const post = forum.createPost(amy, 'deals', { blocks: [para('@ben 看')] })
    const edited = forum.updatePost(amy, post.id, { blocks: [para('@ben @cat 看')] })
    await notices.edited(amy, edited, post.mentions ?? [])
    expect(kinds()).toEqual(['cat:forumMention'])

    sent = []
    const comment = forum.addComment(ben, post.id, { blocks: [para('嗯')] })
    const changed = forum.updateComment(ben, comment.id, { blocks: [para('@boss 嗯')] })
    await notices.edited(ben, post, comment.mentions ?? [], changed)
    expect(sent).toEqual([{ to: 'boss', kind: 'forumMention', params: { postId: post.id, title: '@ben 看', username: 'ben', commentId: comment.id } }])
  })

  it('a pin tells the post’s author, unless they pinned it, and nobody who left', async () => {
    const post = forum.createPost(amy, 'deals', { blocks: [para('x')] })
    await notices.pinned(boss, post)
    expect(kinds()).toEqual(['amy:forumPinned'])

    sent = []
    await notices.pinned(amy, post)
    members = members.filter((m) => m.id !== 'amy')
    await notices.pinned(boss, post)
    expect(sent).toEqual([])
  })
})

describe('forum notification links (e11-t08)', () => {
  it('open the post on BridgeHall, at the comment when there is one', () => {
    const n = (params: Notification['params']): Notification => ({ id: 'n', at: 0, kind: 'forumReply', params, read: false })
    expect(notificationLink(n({ postId: 'p1' }))).toBe(`${BOOK_SITE}/forum/p/p1`)
    expect(notificationLink(n({ postId: 'p1', commentId: 'c2' }))).toBe(`${BOOK_SITE}/forum/p/p1#comment-c2`)
    expect(notificationLink(n({}))).toBe(`${BOOK_SITE}/forum`)
  })
})
