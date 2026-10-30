import type { Seat, Card, Hands } from './cards.ts'
import type { Vulnerability } from './board.ts'
import type { Call } from './auction.ts'

/**
 * The club forum (TKU-BridgeHall E11, this repo's E13): boards, posts and their blocks, comments,
 * reactions and reports. The handbook builds the forum first for the club's members; the types
 * and the Worker module (`worker/forum.ts`, e11-t06) live here so E13 can take them over with only
 * a front end to write (AC-11.8). TKU-BridgeHall `src/lib/forum.ts` is a copy, checked by its type
 * parity (`parity/table-types.ts`). Types and limits only; nothing here depends on the handbook.
 *
 * A post is structured blocks, not HTML: each site draws them with its own components (the deal
 * and the auction with the same cards and calls as `shared/cards.ts` and `shared/auction.ts`).
 */

// ── Boards ───────────────────────────────────────────────────────────────────────────────────

/** Who may start a post on a board: every member, or only officers (`forumModerate`, e11-t09) */
export const BOARD_POST_POLICIES = ['all', 'officers'] as const
export type BoardPostPolicy = (typeof BOARD_POST_POLICIES)[number]

export interface Board {
  id: string
  name: string
  description: string
  /** Lowest first in the board list */
  order: number
  postPolicy: BoardPostPolicy
  /** Shown above the other posts, in this order */
  pinnedPostIds: string[]
}

/**
 * The four boards every club starts with (an admin may rename, reorder or add boards). The home
 * page's 社團新聞 reads `news`; 最新討論 reads the others
 */
export const BUILTIN_BOARDS: readonly Omit<Board, 'pinnedPostIds'>[] = [
  { id: 'news', name: '社團公告', description: '幹部發布的公告與活動', order: 0, postPolicy: 'officers' },
  { id: 'deals', name: '牌局討論', description: '打過的牌、叫牌與打法', order: 1, postPolicy: 'all' },
  { id: 'systems', name: '制度問答', description: '特約與制度的問題', order: 2, postPolicy: 'all' },
  { id: 'chat', name: '閒聊', description: '其他想說的', order: 3, postPolicy: 'all' },
]

export const NEWS_BOARD_ID = 'news'

// ── Blocks ───────────────────────────────────────────────────────────────────────────────────

/** Four hands, the dealer and the vulnerability (the handbook's `Deal`, `src/lib/board.ts`) */
export interface ForumDeal {
  hands: Hands
  dealer: Seat
  vul: Vulnerability
}

/** One call in a posted auction: `AuctionCall` without the robot-only fields */
export interface ForumAuctionCall {
  seat: Seat
  call: Call
  /** The call was alerted; the text is the explanation (may be empty) */
  alert?: string
}

/** An auction and who started it; each call's seat follows from the dealer */
export interface ForumAuction {
  dealer: Seat
  calls: ForumAuctionCall[]
}

/** A list item, nested like the handbook's rules */
export interface ForumRuleItem {
  text: string
  children?: ForumRuleItem[]
}

/**
 * What a post is made of. `paragraph`, `rules` and `note` are the handbook's text blocks (without
 * its 待確認 marks); `hand` is one hand as cards ('SA', 'HT', …), as `HandInput` and the table
 * give it. The handbook's response tables (`responses`) are for conventions, not posts: a post
 * quotes the convention instead (`ref`). Then the bridge blocks:
 * - `deal`: four hands (drawn by the handbook's `DealDiagram`, later the table's `RecordDiagram`)
 * - `auction`: the bidding
 * - `image`: a picture uploaded with `shared/files.ts` (`assetId` is its key)
 * - `ref`: a convention or one of its sections in the handbook; shown with its title and first lines
 * - `record`: one of the table's history records; M1 keeps the id and a link (e11-t20)
 */
export type PostBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'rules'; items: ForumRuleItem[]; ordered?: boolean }
  | { kind: 'note'; tone: 'info' | 'warning'; text: string }
  | { kind: 'hand'; cards: Card[]; label?: string }
  | { kind: 'deal'; deal: ForumDeal; caption?: string }
  | { kind: 'auction'; auction: ForumAuction; caption?: string }
  | { kind: 'image'; assetId: string; alt: string; caption?: string }
  | { kind: 'ref'; slug: string; sectionId?: string }
  | { kind: 'record'; tableRecordId: string }

export type PostBlockKind = PostBlock['kind']
export const POST_BLOCK_KINDS: readonly PostBlockKind[] = [
  'paragraph',
  'rules',
  'note',
  'hand',
  'deal',
  'auction',
  'image',
  'ref',
  'record',
]

/** A comment holds text, an auction or a hand only */
export type CommentBlock = Extract<PostBlock, { kind: 'paragraph' | 'auction' | 'hand' }>
export type CommentBlockKind = CommentBlock['kind']
export const COMMENT_BLOCK_KINDS: readonly CommentBlockKind[] = ['paragraph', 'auction', 'hand']

// ── Reactions ────────────────────────────────────────────────────────────────────────────────

/** The five reactions, in the order the reaction bar shows them */
export const REACTION_EMOJIS = ['👍', '♠', '♥', '♦', '♣'] as const
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number]

/** Who reacted with what, as a post or a comment carries it: each emoji's member ids, oldest first */
export type Reactions = Partial<Record<ReactionEmoji, string[]>>

/** One member's reaction, as the Worker stores it (one row per member, target and emoji) */
export interface Reaction {
  target: 'post' | 'comment'
  targetId: string
  userId: string
  emoji: ReactionEmoji
  createdAt: number
}

// ── Posts and comments ───────────────────────────────────────────────────────────────────────

export interface Post {
  id: string
  boardId: string
  authorId: string
  title?: string
  blocks: PostBlock[]
  createdAt: number
  editedAt?: number
  /** Shown above the board's other posts (`Board.pinnedPostIds` holds the order) */
  pinned?: boolean
  /** No new comments */
  locked?: boolean
  reactions: Reactions
  commentCount: number
  /** The members its text names with `@` (username or display name), in the order they first appear */
  mentions?: string[]
}

/** Comments nest one level: a reply to a reply hangs under the same top comment */
export interface Comment {
  id: string
  postId: string
  /** The top comment this one answers; none for a top comment */
  parentId?: string
  authorId: string
  blocks: CommentBlock[]
  createdAt: number
  editedAt?: number
  reactions: Reactions
  /** The members its text names with `@`, as on a post */
  mentions?: string[]
}

// ── Reports ──────────────────────────────────────────────────────────────────────────────────

export const REPORT_STATUSES = ['open', 'dismissed', 'removed'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

/** A member's report of a post or a comment, for the officers (e11-t09) */
export interface Report {
  id: string
  target: 'post' | 'comment'
  targetId: string
  reporterId: string
  reason: string
  createdAt: number
  status: ReportStatus
  /** The officer who dismissed it or removed what it reported, and when */
  handledBy?: string
  handledAt?: number
}

// ── Limits (E11 非功能需求) ──────────────────────────────────────────────────────────────────

export const FORUM_LIMITS = {
  /** Blocks in one post */
  blocksMax: 20,
  /** Characters of text in one post, all text blocks together */
  postTextMax: 5000,
  imagesMax: 6,
  titleMax: 80,
  /** Characters of text in one comment */
  commentTextMax: 1000,
  /** Posts and comments one member may send in a minute */
  perMinute: 5,
  /** Posts on one page of a board */
  pageSize: 20,
  reportReasonMax: 300,
  /** Open reports one member may have at once, and reports an officer's list shows */
  reportsOpenMax: 20,
  reportsShown: 100,
  /** Characters of a post's text shown for it in a report or a notification */
  excerptMax: 40,
  /** Boards a club may have, and the length of a board's name and description */
  boardsMax: 20,
  boardNameMax: 20,
  boardDescriptionMax: 100,
  /** Posts in each of the home page's two lists (社團新聞, 最新討論) */
  latestShown: 3,
  /** A search (e11-t10): its characters, and its words (split at spaces; a post must hold every one) */
  searchMax: 50,
  searchWordsMax: 5,
} as const

// ── Requests and answers (worker/forum.ts, e11-t06, e11-t07) ─────────────────────────────────

/** `POST /api/forum/boards` (an admin; `id` is a-z, 0-9 and '-') and `PATCH /api/forum/boards/:id` (any field) */
export interface BoardInput {
  id?: string
  name?: string
  description?: string
  order?: number
  postPolicy?: BoardPostPolicy
}

/** `POST /api/forum/boards/:id/posts` and `PATCH /api/forum/posts/:id` */
export interface PostInput {
  title?: string
  blocks: PostBlock[]
}

/** `POST /api/forum/posts/:id/comments` (`parentId` set: a reply) and `PATCH /api/forum/comments/:id` (blocks only) */
export interface CommentInput {
  parentId?: string
  blocks: CommentBlock[]
}

/** `GET /api/forum/boards/:id/posts?page=`: the pinned posts (page 1 only), then newest first */
export interface BoardPage {
  board: Board
  pinned: Post[]
  posts: Post[]
  /** From 1 */
  page: number
  /** At least 1 */
  pages: number
}

/**
 * `GET /api/forum/feed?page=`: every board's posts newest first (the forum's front page, BridgeHall
 * e11-t15); no pinned section. `&author=<member id>`: only that member's posts (我的貼文);
 * `&mentions=<member id>`: only posts that member is `@`-mentioned in, in the post or a comment (e11-t10)
 */
export interface ForumFeed {
  posts: Post[]
  /** From 1 */
  page: number
  /** At least 1 */
  pages: number
}

/**
 * `GET /api/forum/search?q=&page=` (e11-t10): posts whose title or text blocks (paragraphs, notes,
 * lists) hold every word of `q`, newest first; `query` is the words as searched, `total` how many posts
 * match. 400 `badContent` when `q` is empty or over FORUM_LIMITS.searchMax / searchWordsMax
 */
export interface ForumSearch extends ForumFeed {
  query: string
  total: number
}

/** `GET /api/forum/posts/:id`: the post and every comment, oldest first (replies after their top comment's earlier ones) */
export interface PostThread {
  post: Post
  comments: Comment[]
}

/** `GET /api/forum/latest`: the home page's 社團新聞 (the news board, pinned first) and 最新討論 (the other boards) */
export interface ForumLatest {
  news: Post[]
  discussions: Post[]
}

/** `POST /api/forum/reports` (any member, e11-t09): a post or a comment, and why; a second report of the same one while it is open changes the reason */
export interface ReportInput {
  target: 'post' | 'comment'
  targetId: string
  reason: string
}

/**
 * `POST /api/forum/reports/:id` (an officer): `dismiss` keeps what was reported; `remove` deletes
 * it (a post with its comments, a top comment with its replies). Either closes every open report of it
 */
export interface ReportDecision {
  action: 'dismiss' | 'remove'
}

/**
 * `GET /api/forum/reports?status=open|all` (an officer): a report, newest first, with what it
 * reported. `postId` is the post it is in (gone: deleted since); `authorId` and `excerpt` (the
 * title or the start of the text, at most FORUM_LIMITS.excerptMax characters) are what is there now
 */
export interface ReportItem {
  report: Report
  postId?: string
  authorId?: string
  excerpt?: string
}
