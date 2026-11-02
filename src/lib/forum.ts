import type { BoardPage, Comment, CommentInput, ForumFeed, Board, Post, PostInput, PostThread } from '../../shared/forum.ts'
import { request } from './api.ts'

/**
 * The forum's API for the table's pages (E13 K1, ARCHITECTURE.md §5.19): the same `/api/forum/*`
 * as BridgeHall's forum (`worker/forum.ts`), so both sites show the same posts. Only what the
 * table's pages use so far: reading boards, posts and comments; writing, editing (posts) and
 * deleting posts and comments (K2, the post editor).
 * Errors come back as `ApiError` with the server's code (404 `forumBoardGone`, `postGone`,
 * `commentGone`; 403 `notYours`, `forumBoardOfficersOnly`; 409 `postLocked`; 429 `slowDown`; 400 `badContent`).
 */

const id = (value: string) => encodeURIComponent(value)
const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const forumApi = {
  boards: () => request<{ boards: Board[] }>('/api/forum/boards').then((r) => r.boards),
  /** Pinned posts on page 1, then newest first, FORUM_LIMITS.pageSize a page */
  boardPage: (boardId: string, page = 1) => request<BoardPage>(`/api/forum/boards/${id(boardId)}/posts?page=${page}`),
  /**
   * Every board's posts newest first, no pinned section; `author`: only that member's (their profile
   * page, e13-t08), none when they keep their posts off it
   */
  feed: (page = 1, author?: string) =>
    request<ForumFeed>(`/api/forum/feed?page=${page}${author ? `&author=${id(author)}` : ''}`),
  /** The post and every comment, oldest first */
  post: (postId: string) => request<PostThread>(`/api/forum/posts/${id(postId)}`),
  /** A new post on a board (an officers-only board takes only the officers') */
  createPost: (boardId: string, input: PostInput) =>
    send<{ post: Post }>('POST', `/api/forum/boards/${id(boardId)}/posts`, input).then((r) => r.post),
  /** Only its author: title and blocks */
  updatePost: (postId: string, input: PostInput) => send<{ post: Post }>('PATCH', `/api/forum/posts/${id(postId)}`, input).then((r) => r.post),
  /** The author or an officer; its comments go with it */
  deletePost: (postId: string) => send<{ ok: true }>('DELETE', `/api/forum/posts/${id(postId)}`),
  /** `parentId` set: a reply (hung under that top comment) */
  comment: (postId: string, input: CommentInput) =>
    send<{ comment: Comment }>('POST', `/api/forum/posts/${id(postId)}/comments`, input).then((r) => r.comment),
  /** The author or an officer; a top comment goes with its replies */
  deleteComment: (commentId: string) => send<{ ok: true }>('DELETE', `/api/forum/comments/${id(commentId)}`),
}
