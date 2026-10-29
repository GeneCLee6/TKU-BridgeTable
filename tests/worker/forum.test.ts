// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_BOARDS, FORUM_LIMITS, type PostBlock } from '../../shared/forum.ts'
import type { Me } from '../../shared/protocol.ts'
import { ForumService, mentionsIn } from '../../worker/forum.ts'
import { forumRouteNeed } from '../../worker/roles.ts'
import { memorySql } from './sqlite.ts'

const me = (id: string, admin = false): Me => ({ id, username: `n${id}`, admin, permissions: [] })
const admin = me('boss', true)
const amy = me('amy')
const ben = me('ben')
const MEMBERS = [
  { id: 'amy', username: 'amy', displayName: '艾咪' },
  { id: 'ben', username: 'ben' },
  { id: 'boss', username: 'boss', displayName: 'Boss Lee' },
]

let forum: ForumService
let time: number
let ids: number

const make = () =>
  new ForumService(memorySql(), { now: () => time, newId: () => `id${++ids}`, members: () => MEMBERS })

beforeEach(() => {
  time = 1_000_000
  ids = 0
  forum = make()
  forum.createTables()
})

const para = (text: string): PostBlock => ({ kind: 'paragraph', text })
/** Posts as different members so the rate limit stays out of the way */
const postAs = (who: Me, board = 'deals', text = '一副牌') => {
  time += 60_000
  return forum.createPost(who, board, { blocks: [para(text)] })
}

describe('boards (e11-t06, AC-11.2)', () => {
  it('starts with the four built-in boards, in order, and keeps an admin’s changes when made again', () => {
    expect(forum.boards().map((b) => b.id)).toEqual(['news', 'deals', 'systems', 'chat'])
    expect(forum.board('news')).toEqual({ ...BUILTIN_BOARDS[0], pinnedPostIds: [] })
    forum.updateBoard('chat', { name: '聊天室', order: 0 })
    forum.createTables()
    expect(forum.board('chat')).toMatchObject({ name: '聊天室', order: 0 })
    expect(forum.boards()[0].id).toBe('chat')
  })

  it('adds, changes and deletes a board, checking its fields', () => {
    const board = forum.createBoard({ id: 'events', name: '比賽', description: '比賽資訊' })
    expect(board).toEqual({ id: 'events', name: '比賽', description: '比賽資訊', order: 4, postPolicy: 'all', pinnedPostIds: [] })
    expect(() => forum.createBoard({ id: 'events', name: 'x' })).toThrow(expect.objectContaining({ code: 'forumBoardExists' }))
    expect(() => forum.createBoard({ id: 'Bad Id', name: 'x' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(() => forum.createBoard({ name: '' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(() => forum.createBoard({ name: 'x', postPolicy: 'nobody' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(forum.createBoard({ name: '自動代號' }).id).toBe('id1')
    expect(forum.updateBoard('events', { postPolicy: 'officers', order: 9 })).toMatchObject({ postPolicy: 'officers', order: 9 })
    expect(() => forum.updateBoard('events', { id: 'other' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    forum.deleteBoard('events')
    expect(() => forum.board('events')).toThrow(expect.objectContaining({ code: 'forumBoardGone', status: 404 }))
  })

  it('never deletes a built-in board or one with posts, and caps the number of boards', () => {
    expect(() => forum.deleteBoard('chat')).toThrow(expect.objectContaining({ code: 'forumBoardBuiltIn' }))
    forum.createBoard({ id: 'x', name: 'x' })
    postAs(amy, 'x')
    expect(() => forum.deleteBoard('x')).toThrow(expect.objectContaining({ code: 'forumBoardNotEmpty' }))
    for (let i = forum.boards().length; i < FORUM_LIMITS.boardsMax; i++) forum.createBoard({ name: `b${i}` })
    expect(() => forum.createBoard({ name: 'one more' })).toThrow(expect.objectContaining({ code: 'forumBoardLimit' }))
  })

  it('lets only officers post on the news board', () => {
    expect(() => postAs(amy, 'news')).toThrow(expect.objectContaining({ code: 'forumBoardOfficersOnly', status: 403 }))
    expect(postAs(admin, 'news').boardId).toBe('news')
  })
})

describe('posts (e11-t06, AC-11.3)', () => {
  it('stores a post with every kind of block and gives it back as sent', () => {
    const blocks: PostBlock[] = [
      para('這副牌怎麼叫？'),
      { kind: 'rules', items: [{ text: '一', children: [{ text: '一之一' }] }], ordered: true },
      { kind: 'note', tone: 'warning', text: '小心' },
      { kind: 'hand', cards: ['SA', 'SK', 'HT'], label: '南' },
      {
        kind: 'deal',
        deal: { hands: { N: ['SA'], E: ['SK'], S: ['SQ'], W: ['SJ'] }, dealer: 'N', vul: 'NS' },
        caption: '第 3 副',
      },
      {
        kind: 'auction',
        auction: { dealer: 'N', calls: [{ seat: 'N', call: '1C', alert: '可能短' }, { seat: 'E', call: 'X' }, { seat: 'S', call: 'XX' }] },
      },
      { kind: 'image', assetId: 'post/0123456789abcdef01234567.jpg', alt: '牌桌照片' },
      { kind: 'ref', slug: 'stayman', sectionId: 'basic' },
      { kind: 'record', tableRecordId: 'abc123' },
    ]
    const post = forum.createPost(amy, 'deals', { title: ' 第三副 ', blocks })
    expect(post).toEqual({ id: 'id1', boardId: 'deals', authorId: 'amy', title: '第三副', blocks, createdAt: time, reactions: {}, commentCount: 0 })
    expect(forum.thread('id1')).toEqual({ post, comments: [] })
  })

  it('drops fields a block does not have and refuses what is not valid', () => {
    const post = forum.createPost(amy, 'deals', { blocks: [{ kind: 'paragraph', text: 'hi', html: '<b>' }] })
    expect(post.blocks).toEqual([para('hi')])
    const bad = (blocks: unknown, title?: unknown) => () => {
      time += 60_000
      forum.createPost(ben, 'deals', { title, blocks })
    }
    const invalid = expect.objectContaining({ code: 'badContent' })
    expect(bad([])).toThrow(invalid)
    expect(bad([{ kind: 'responses', rows: [] }])).toThrow(invalid)
    expect(bad([para('   ')])).toThrow(invalid)
    expect(bad([para('x')], 'x'.repeat(FORUM_LIMITS.titleMax + 1))).toThrow(invalid)
    expect(bad(Array.from({ length: FORUM_LIMITS.blocksMax + 1 }, () => para('x')))).toThrow(invalid)
    expect(bad([para('x'.repeat(3000)), para('x'.repeat(2001))])).toThrow(invalid)
    expect(bad(Array.from({ length: 7 }, () => ({ kind: 'image', assetId: 'post/0123456789abcdef01234567.png', alt: '' })))).toThrow(invalid)
    expect(bad([{ kind: 'image', assetId: 'avatar/x.png', alt: '' }])).toThrow(invalid)
    expect(bad([{ kind: 'hand', cards: ['SA', 'SA'] }])).toThrow(invalid)
    expect(bad([{ kind: 'hand', cards: ['S1'] }])).toThrow(invalid)
    expect(bad([{ kind: 'deal', deal: { hands: { N: ['SA'], S: ['SA'] }, dealer: 'N', vul: 'None' } }])).toThrow(invalid)
    expect(bad([{ kind: 'deal', deal: { hands: { N: ['SA'] }, dealer: 'N', vul: 'All' } }])).toThrow(invalid)
    // A call in the wrong turn, a bid below the last one, a double of partner, a call after the end
    expect(bad([{ kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'E', call: '1C' }] } }])).toThrow(invalid)
    expect(bad([{ kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'N', call: '1S' }, { seat: 'E', call: '1H' }] } }])).toThrow(invalid)
    expect(
      bad([{ kind: 'auction', auction: { dealer: 'N', calls: [{ seat: 'N', call: '1S' }, { seat: 'E', call: 'P' }, { seat: 'S', call: 'X' }] } }]),
    ).toThrow(invalid)
    const passed = ['N', 'E', 'S', 'W', 'N'].map((seat) => ({ seat, call: 'P' }))
    expect(bad([{ kind: 'auction', auction: { dealer: 'N', calls: passed } }])).toThrow(invalid)
    expect(bad([{ kind: 'ref', slug: '../etc' }])).toThrow(invalid)
  })

  it('lets only the author edit, and the author or an officer delete with the comments and reactions', () => {
    const post = postAs(amy)
    time += 5
    expect(forum.updatePost(amy, post.id, { title: '新標題', blocks: [para('改過')] })).toMatchObject({
      title: '新標題',
      blocks: [para('改過')],
      editedAt: time,
    })
    expect(() => forum.updatePost(ben, post.id, { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'notYours', status: 403 }))
    expect(() => forum.updatePost(admin, post.id, { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'notYours' }))
    expect(() => forum.deletePost(ben, post.id)).toThrow(expect.objectContaining({ code: 'notYours' }))
    const comment = forum.addComment(ben, post.id, { blocks: [para('好牌')] })
    forum.react(amy, 'comment', comment.id, { emoji: '♠' })
    forum.react(ben, 'post', post.id, { emoji: '👍' })
    forum.deletePost(admin, post.id)
    expect(() => forum.post(post.id)).toThrow(expect.objectContaining({ code: 'postGone', status: 404 }))
    expect(() => forum.comment(comment.id)).toThrow(expect.objectContaining({ code: 'commentGone' }))
    const other = postAs(amy)
    forum.deletePost(amy, other.id)
    expect(forum.boardPage('deals').posts).toEqual([])
  })

  it('pages a board newest first with the pinned posts on top of page 1 (AC-11.2)', () => {
    const posts = Array.from({ length: FORUM_LIMITS.pageSize + 5 }, (_, i) => postAs(i % 2 ? amy : ben, 'deals', `第 ${i} 篇`))
    forum.setPinned(posts[3].id, { pinned: true })
    time += 1
    forum.setPinned(posts[7].id, { pinned: true })
    const first = forum.boardPage('deals')
    expect(first.pinned.map((p) => p.id)).toEqual([posts[7].id, posts[3].id])
    expect(first.pinned[0].pinned).toBe(true)
    expect(first.board.pinnedPostIds).toEqual([posts[7].id, posts[3].id])
    expect(first.posts).toHaveLength(FORUM_LIMITS.pageSize)
    expect(first.posts[0].id).toBe(posts.at(-1)!.id)
    expect(first).toMatchObject({ page: 1, pages: 2 })
    const second = forum.boardPage('deals', 2)
    expect(second.pinned).toEqual([])
    expect(second.posts.map((p) => p.id)).toEqual([posts[2].id, posts[1].id, posts[0].id])
    expect(forum.boardPage('deals', 0).page).toBe(1)
    expect(forum.boardPage('chat')).toMatchObject({ posts: [], pinned: [], pages: 1 })
    forum.setPinned(posts[7].id, { pinned: false })
    expect(forum.board('deals').pinnedPostIds).toEqual([posts[3].id])
    expect(() => forum.setPinned(posts[3].id, { pinned: 'yes' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(() => forum.boardPage('nope')).toThrow(expect.objectContaining({ code: 'forumBoardGone' }))
  })

  it('gives the home page the news, pinned first, and the newest of the other boards', () => {
    const news = [postAs(admin, 'news', '一'), postAs(admin, 'news', '二'), postAs(admin, 'news', '三'), postAs(admin, 'news', '四')]
    forum.setPinned(news[0].id, { pinned: true })
    const talk = [postAs(amy, 'deals'), postAs(ben, 'systems'), postAs(amy, 'chat'), postAs(ben, 'chat')]
    const latest = forum.latest()
    expect(latest.news.map((p) => p.id)).toEqual([news[0].id, news[3].id, news[2].id])
    expect(latest.discussions.map((p) => p.id)).toEqual([talk[3].id, talk[2].id, talk[1].id])
  })

  it('lists every board newest first on the feed, a page at a time (e11-t15)', () => {
    const first = postAs(admin, 'news', '公告')
    forum.setPinned(first.id, { pinned: true })
    const talk = [postAs(amy, 'deals'), postAs(ben, 'systems'), postAs(amy, 'chat')]
    const feed = forum.feed()
    expect(feed.posts.map((p) => p.id)).toEqual([talk[2].id, talk[1].id, talk[0].id, first.id])
    expect(feed).toMatchObject({ page: 1, pages: 1 })
    expect(forum.feed(2).posts).toEqual([])
    expect(forum.feed(0).page).toBe(1)
  })

  it('limits each member to FORUM_LIMITS.perMinute posts and comments a minute', () => {
    const post = forum.createPost(amy, 'deals', { blocks: [para('1')] })
    for (let i = 1; i < FORUM_LIMITS.perMinute; i++) forum.addComment(amy, post.id, { blocks: [para(`${i}`)] })
    expect(() => forum.createPost(amy, 'deals', { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'slowDown', status: 429 }))
    expect(() => forum.addComment(amy, post.id, { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'slowDown' }))
    // Others are not held up, editing is not counted, and a refused post costs nothing
    forum.createPost(ben, 'deals', { blocks: [para('x')] })
    forum.updatePost(amy, post.id, { blocks: [para('edited')] })
    time += 12_000
    expect(forum.addComment(amy, post.id, { blocks: [para('again')] }).postId).toBe(post.id)
  })
})

describe('locking (e11-t06, AC-11.6)', () => {
  it('stops new comments on a locked post, except an officer’s, until it is opened again', () => {
    const post = postAs(amy)
    expect(forum.setLocked(post.id, { locked: true }).locked).toBe(true)
    expect(() => forum.addComment(ben, post.id, { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'postLocked' }))
    expect(forum.addComment(admin, post.id, { blocks: [para('鎖了')] }).authorId).toBe('boss')
    expect(forum.setLocked(post.id, { locked: false }).locked).toBeUndefined()
    expect(forum.addComment(ben, post.id, { blocks: [para('好')] }).authorId).toBe('ben')
  })
})

describe('comments (e11-t07, AC-11.4)', () => {
  it('nests one level: a reply to a reply hangs under the same top comment, and counts are kept', () => {
    const post = postAs(amy)
    const top = forum.addComment(ben, post.id, { blocks: [para('第一')] })
    time += 1
    const reply = forum.addComment(amy, post.id, { parentId: top.id, blocks: [{ kind: 'hand', cards: ['SA'] }] })
    time += 1
    const deeper = forum.addComment(admin, post.id, {
      parentId: reply.id,
      blocks: [{ kind: 'auction', auction: { dealer: 'S', calls: [{ seat: 'S', call: '1N' }] } }],
    })
    expect(reply.parentId).toBe(top.id)
    expect(deeper.parentId).toBe(top.id)
    expect(top.parentId).toBeUndefined()
    const thread = forum.thread(post.id)
    expect(thread.post.commentCount).toBe(3)
    expect(thread.comments.map((c) => c.id)).toEqual([top.id, reply.id, deeper.id])
    const other = postAs(ben)
    expect(() => forum.addComment(ben, other.id, { parentId: top.id, blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(() => forum.addComment(ben, post.id, { parentId: 'nope', blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'commentGone' }))
  })

  it('holds text, an auction or a hand only, up to FORUM_LIMITS.commentTextMax characters', () => {
    const post = postAs(amy)
    const invalid = expect.objectContaining({ code: 'badContent' })
    expect(() => forum.addComment(ben, post.id, { blocks: [{ kind: 'note', tone: 'info', text: 'x' }] })).toThrow(invalid)
    expect(() => forum.addComment(ben, post.id, { blocks: [para('x'.repeat(FORUM_LIMITS.commentTextMax + 1))] })).toThrow(invalid)
    expect(() => forum.addComment(ben, 'nope', { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'postGone' }))
  })

  it('lets only the author edit, and the author or an officer delete, a top comment taking its replies', () => {
    const post = postAs(amy)
    const top = forum.addComment(ben, post.id, { blocks: [para('一')] })
    forum.addComment(amy, post.id, { parentId: top.id, blocks: [para('二')] })
    const lone = forum.addComment(amy, post.id, { blocks: [para('三')] })
    time += 3
    expect(forum.updateComment(ben, top.id, { blocks: [para('改')] })).toMatchObject({ blocks: [para('改')], editedAt: time })
    expect(() => forum.updateComment(amy, top.id, { blocks: [para('x')] })).toThrow(expect.objectContaining({ code: 'notYours' }))
    expect(() => forum.deleteComment(amy, top.id)).toThrow(expect.objectContaining({ code: 'notYours' }))
    forum.deleteComment(admin, top.id)
    expect(forum.thread(post.id)).toMatchObject({ post: { commentCount: 1 }, comments: [{ id: lone.id }] })
    forum.deleteComment(amy, lone.id)
    expect(forum.thread(post.id)).toMatchObject({ post: { commentCount: 0 }, comments: [] })
  })
})

describe('reactions (e11-t07, AC-11.4)', () => {
  it('keeps one of the five reactions per member, in the reaction bar’s order', () => {
    const post = postAs(amy)
    forum.react(ben, 'post', post.id, { emoji: '♥' })
    time += 1
    forum.react(amy, 'post', post.id, { emoji: '♥' })
    time += 1
    expect(forum.react(admin, 'post', post.id, { emoji: '👍' })).toEqual({ '👍': ['boss'], '♥': ['ben', 'amy'] })
    time += 1
    expect(forum.react(ben, 'post', post.id, { emoji: '♣' })).toEqual({ '👍': ['boss'], '♥': ['amy'], '♣': ['ben'] })
    expect(forum.unreact(admin, 'post', post.id)).toEqual({ '♥': ['amy'], '♣': ['ben'] })
    expect(forum.post(post.id).reactions).toEqual({ '♥': ['amy'], '♣': ['ben'] })
    expect(() => forum.react(ben, 'post', post.id, { emoji: '😀' })).toThrow(expect.objectContaining({ code: 'badContent' }))
    expect(() => forum.react(ben, 'post', 'nope', { emoji: '♠' })).toThrow(expect.objectContaining({ code: 'postGone' }))
  })

  it('reacts to comments too, shown with the thread', () => {
    const post = postAs(amy)
    const comment = forum.addComment(ben, post.id, { blocks: [para('x')] })
    forum.react(amy, 'comment', comment.id, { emoji: '♦' })
    expect(forum.thread(post.id).comments[0].reactions).toEqual({ '♦': ['amy'] })
    expect(forum.thread(post.id).post.reactions).toEqual({})
  })
})

describe('mentions (e11-t07, AC-11.4)', () => {
  it('reads @username in any case and @display name, the longest name first, each member once', () => {
    const members = [...MEMBERS, { id: 'boss2', username: 'boss2' }]
    expect(mentionsIn(['@Amy 你看 @ben，還有 @艾咪'], members)).toEqual(['amy', 'ben'])
    expect(mentionsIn(['問 @Boss Lee 和 @boss2'], members)).toEqual(['boss', 'boss2'])
    expect(mentionsIn(['@amyx 不是誰，email a@ben.tw 也不算'], members)).toEqual([])
    expect(mentionsIn(['問@ben'], members)).toEqual(['ben'])
    expect(mentionsIn(['@艾咪你好'], members)).toEqual(['amy'])
    expect(mentionsIn(['沒有人'], members)).toEqual([])
  })

  it('keeps the mentions of a post’s and a comment’s text, and reads them again on an edit', () => {
    const post = forum.createPost(amy, 'deals', {
      blocks: [para('@ben 這樣叫對嗎'), { kind: 'rules', items: [{ text: '問 @Boss Lee' }] }],
    })
    expect(post.mentions).toEqual(['ben', 'boss'])
    expect(forum.updatePost(amy, post.id, { blocks: [para('算了')] }).mentions).toBeUndefined()
    expect(forum.addComment(ben, post.id, { blocks: [para('@艾咪 對')] }).mentions).toEqual(['amy'])
  })
})

describe('forum routes (roles.ts)', () => {
  it('asks members to sign in, admins for the boards and officers for pinning and locking', () => {
    expect(forumRouteNeed('GET', '/boards')).toBe('member')
    expect(forumRouteNeed('POST', '/boards')).toBe('admin')
    expect(forumRouteNeed('PATCH', '/boards/chat')).toBe('admin')
    expect(forumRouteNeed('DELETE', '/boards/chat')).toBe('admin')
    expect(forumRouteNeed('GET', '/boards/chat/posts')).toBe('member')
    expect(forumRouteNeed('POST', '/boards/chat/posts')).toBe('member')
    expect(forumRouteNeed('GET', '/latest')).toBe('member')
    expect(forumRouteNeed('GET', '/feed')).toBe('member')
    expect(forumRouteNeed('POST', '/feed')).toBeNull()
    expect(forumRouteNeed('PATCH', '/posts/abc')).toBe('member')
    expect(forumRouteNeed('POST', '/posts/abc/pin')).toBe('admin')
    expect(forumRouteNeed('POST', '/posts/abc/lock')).toBe('admin')
    expect(forumRouteNeed('POST', '/posts/abc/comments')).toBe('member')
    expect(forumRouteNeed('DELETE', '/comments/abc')).toBe('member')
    expect(forumRouteNeed('PUT', '/comments/abc/reaction')).toBe('member')
    expect(forumRouteNeed('GET', '/posts/abc/pin')).toBeNull()
    expect(forumRouteNeed('PUT', '/boards')).toBeNull()
    expect(forumRouteNeed('GET', '/nothing')).toBeNull()
  })
})
