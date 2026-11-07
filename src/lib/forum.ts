import type {
  BoardPage,
  Comment,
  CommentBlock,
  CommentInput,
  ForumFeed,
  ForumSearch,
  ForumLatest,
  ForumTags,
  ForumUnpublished,
  Board,
  Post,
  PostInput,
  PostThread,
  ReactionEmoji,
  Reactions,
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
 * deleting posts and comments (K2, the post editor); search, reports and hiding (K4); tags (AC-13.7);
 * drafts, scheduled posts and the home page's announcements (e13-t12); reactions, pins and editing comments (AC-13.1).
 * Errors come back as `ApiError` with the server's code (404 `forumBoardGone`, `postGone`,
 * `commentGone`, `forumReportGone`; 403 `notYours`, `forumBoardOfficersOnly`, `forumScheduleOfficersOnly`;
 * 409 `postLocked`, `postNotPublished`, `forumReportHandled`, `forumReportLimit`, `forumDraftLimit`;
 * 429 `slowDown`; 400 `badContent`, `forumScheduleTime`).
 */

type ForumTarget = 'post' | 'comment'

const id = (value: string) => encodeURIComponent(value)
const send = <T>(method: string, path: string, body?: unknown) =>
  request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const forumApi = {
  boards: () => request<{ boards: Board[] }>('/api/forum/boards').then((r) => r.boards),
  /** Pinned posts on page 1, then newest first, FORUM_LIMITS.pageSize a page; `tag`: only posts with it (AC-13.7) */
  boardPage: (boardId: string, page = 1, tag?: string) =>
    request<BoardPage>(`/api/forum/boards/${id(boardId)}/posts?page=${page}${tag ? `&tag=${id(tag)}` : ''}`),
  /**
   * Every board's posts newest first, no pinned section; `author`: only that member's (their profile
   * page, e13-t08), none when they keep their posts off it; `tag`: only posts with it (AC-13.7)
   */
  feed: (page = 1, author?: string, tag?: string) =>
    request<ForumFeed>(`/api/forum/feed?page=${page}${author ? `&author=${id(author)}` : ''}${tag ? `&tag=${id(tag)}` : ''}`),
  /** The home page's lists: the news board (pinned first) and the newest of the other boards (e13-t12) */
  latest: () => request<ForumLatest>('/api/forum/latest'),
  /** My drafts and scheduled posts, and for an officer everyone's scheduled ones (e13-t12) */
  drafts: () => request<ForumUnpublished>('/api/forum/drafts').then((r) => r.posts),
  /** The tags in use, most posts first (AC-13.7): the editor's suggestions and the tag filters */
  tags: () => request<ForumTags>('/api/forum/tags').then((r) => r.tags),
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
  /**
   * Titles and text blocks holding every word of `query`, newest first; `board`: only that board's
   * (K4, e13-t11); `tag`: only posts with it, and then `query` may be empty (AC-13.7)
   */
  search: (query: string, page = 1, board?: string, tag?: string) =>
    request<ForumSearch>(
      `/api/forum/search?${new URLSearchParams({ q: query, page: String(page), ...(board ? { board } : {}), ...(tag ? { tag } : {}) })}`,
    ),
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
  /** Officers: pin a post above the board's others, or take it down (AC-13.1) */
  pin: (postId: string, pinned: boolean) => send<{ post: Post }>('POST', `/api/forum/posts/${id(postId)}/pin`, { pinned }).then((r) => r.post),
  /** My one reaction to a post or a comment (AC-13.1); another emoji replaces it. The target's reactions now */
  react: (target: ForumTarget, targetId: string, emoji: ReactionEmoji) =>
    send<{ reactions: Reactions }>('PUT', `/api/forum/${target}s/${id(targetId)}/reaction`, { emoji }).then((r) => r.reactions),
  /** Takes my reaction back */
  unreact: (target: ForumTarget, targetId: string) =>
    send<{ reactions: Reactions }>('DELETE', `/api/forum/${target}s/${id(targetId)}/reaction`).then((r) => r.reactions),
  /** Only its author: a comment's blocks (AC-13.1) */
  updateComment: (commentId: string, blocks: CommentBlock[]) =>
    send<{ comment: Comment }>('PATCH', `/api/forum/comments/${id(commentId)}`, { blocks }).then((r) => r.comment),
}
