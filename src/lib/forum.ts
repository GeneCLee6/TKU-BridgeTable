import type {
  BoardPage,
  Comment,
  CommentInput,
  ForumFeed,
  ForumSearch,
  Board,
  Post,
  PostInput,
  PostThread,
  Report,
  ReportDecision,
  ReportInput,
  ReportItem,
} from '../../shared/forum.ts'
import { request } from './api.ts'

/**
 * The forum's API for the table's pages (E13 K1, ARCHITECTURE.md §5.19): the same `/api/forum/*`
 * as BridgeHall's forum (`worker/forum.ts`), so both sites show the same posts. Only what the
 * table's pages use so far: reading boards, posts and comments; writing, editing (posts) and
 * deleting posts and comments (K2, the post editor); search, reports and hiding (K4).
 * Errors come back as `ApiError` with the server's code (404 `forumBoardGone`, `postGone`,
 * `commentGone`, `forumReportGone`; 403 `notYours`, `forumBoardOfficersOnly`; 409 `postLocked`,
 * `forumReportHandled`, `forumReportLimit`; 429 `slowDown`; 400 `badContent`).
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
  /** Titles and text blocks holding every word of `query`, newest first; `board`: only that board's (K4, e13-t11) */
  search: (query: string, page = 1, board?: string) =>
    request<ForumSearch>(`/api/forum/search?${new URLSearchParams({ q: query, page: String(page), ...(board ? { board } : {}) })}`),
  /** Any member reports someone else's post or comment (K4, e13-t10); again while it is open changes the reason */
  report: (input: ReportInput) => send<{ report: Report }>('POST', '/api/forum/reports', input).then((r) => r.report),
  /** Officers: the open reports, or every one (`all`), newest first */
  reports: (status: 'open' | 'all' = 'open') =>
    request<{ reports: ReportItem[] }>(`/api/forum/reports?status=${status}`).then((r) => r.reports),
  /** Officers: dismiss a report, or delete what it reported; 409 `forumReportHandled` when someone else did */
  decide: (reportId: string, action: ReportDecision['action']) =>
    send<{ report: Report }>('POST', `/api/forum/reports/${id(reportId)}`, { action }).then((r) => r.report),
  /** Officers: hide a post from everyone but its author and the officers, or show it again; hiding closes its reports */
  hide: (postId: string, hidden: boolean) => send<{ post: Post }>('POST', `/api/forum/posts/${id(postId)}/hide`, { hidden }).then((r) => r.post),
}
