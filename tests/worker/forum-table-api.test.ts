// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { forumRouteNeed } from '../../worker/roles.ts'
import { forumApi } from '../../src/lib/forum.ts'

/**
 * The table's pages call the same `/api/forum/*` as BridgeHall: what `src/lib/forum.ts` sends for
 * reactions, pins and editing a comment (AC-13.1) is what the Worker's routes take, with the rights they ask
 */

const request = vi.hoisted(() => vi.fn())
vi.mock('../../src/lib/api.ts', () => ({ request }))

beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({ reactions: {}, post: {}, comment: {} })
})

/** The last request's method, path under `/api/forum`, and body */
function sent() {
  const [path, init] = request.mock.calls.at(-1) as [string, { method: string; body?: string }]
  expect(path.startsWith('/api/forum/')).toBe(true)
  return { method: init.method, path: path.slice('/api/forum'.length), body: init.body === undefined ? undefined : JSON.parse(init.body) }
}

describe('the forum API for AC-13.1', () => {
  it('reacts to a post or a comment, and takes it back, as any member', async () => {
    await forumApi.react('post', 'p1', '👍')
    expect(sent()).toEqual({ method: 'PUT', path: '/posts/p1/reaction', body: { emoji: '👍' } })
    expect(forumRouteNeed('PUT', sent().path)).toBe('member')
    await forumApi.react('comment', 'c1', '♠')
    expect(sent()).toEqual({ method: 'PUT', path: '/comments/c1/reaction', body: { emoji: '♠' } })
    await forumApi.unreact('comment', 'c1')
    expect(sent()).toEqual({ method: 'DELETE', path: '/comments/c1/reaction', body: undefined })
    expect(forumRouteNeed('DELETE', sent().path)).toBe('member')
  })

  it('pins a post only with the forum officers’ right', async () => {
    await forumApi.pin('p1', true)
    expect(sent()).toEqual({ method: 'POST', path: '/posts/p1/pin', body: { pinned: true } })
    expect(forumRouteNeed('POST', sent().path)).toBe('forumModerate')
    await forumApi.pin('p1', false)
    expect(sent().body).toEqual({ pinned: false })
  })

  it('edits a comment with its blocks', async () => {
    await forumApi.updateComment('c1', [{ kind: 'paragraph', text: '改過了' }])
    expect(sent()).toEqual({ method: 'PATCH', path: '/comments/c1', body: { blocks: [{ kind: 'paragraph', text: '改過了' }] } })
    expect(forumRouteNeed('PATCH', sent().path)).toBe('member')
  })
})
