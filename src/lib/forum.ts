import type { BoardPage, Comment, CommentInput, ForumFeed, Board, PostThread } from '../../shared/forum.ts'
import { request } from './api.ts'

/**
 * The forum's API for the table's pages (E13 K1, ARCHITECTURE.md §5.19): the same `/api/forum/*`
 * as BridgeHall's forum (`worker/forum.ts`), so both sites show the same posts. Only what the
 * table's pages use so far: reading boards, posts and comments, and writing or deleting a comment.
 * Errors come back as `ApiError` with the server's code (404 `forumBoardGone`, `postGone`,
 * `commentGone`; 403 `notYours`; 409 `postLocked`; 429 `slowDown`; 400 `badContent`).
 */

const id = (value: string) => encodeURIComponent(value)
const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const forumApi = {
  boards: () => request<{ boards: Board[] }>('/api/forum/boards').then((r) => r.boards),
  /** Pinned posts on page 1, then newest first, FORUM_LIMITS.pageSize a page */
  boardPage: (boardId: string, page = 1) => request<BoardPage>(`/api/forum/boards/${id(boardId)}/posts?page=${page}`),
  /** Every board's posts newest first, no pinned section */
  feed: (page = 1) => request<ForumFeed>(`/api/forum/feed?page=${page}`),
  /** The post and every comment, oldest first */
  post: (postId: string) => request<PostThread>(`/api/forum/posts/${id(postId)}`),
  /** `parentId` set: a reply (hung under that top comment) */
  comment: (postId: string, input: CommentInput) =>
    send<{ comment: Comment }>('POST', `/api/forum/posts/${id(postId)}/comments`, input).then((r) => r.comment),
  /** The author or an officer; a top comment goes with its replies */
  deleteComment: (commentId: string) => send<{ ok: true }>('DELETE', `/api/forum/comments/${id(commentId)}`),
}
