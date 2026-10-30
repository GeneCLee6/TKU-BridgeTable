import { isCall, legalCalls } from '../shared/auction.ts'
import { isCard, isSeat, SEATS, type Card, type Seat } from '../shared/cards.ts'
import { FILE_KEY } from '../shared/files.ts'
import {
  BOARD_POST_POLICIES,
  BUILTIN_BOARDS,
  COMMENT_BLOCK_KINDS,
  FORUM_LIMITS,
  NEWS_BOARD_ID,
  REACTION_EMOJIS,
  type Board,
  type BoardPage,
  type BoardPostPolicy,
  type Comment,
  type CommentBlock,
  type ForumAuctionCall,
  type ForumFeed,
  type ForumSearch,
  type ForumLatest,
  type ForumRuleItem,
  type Post,
  type PostBlock,
  type PostThread,
  type ReactionEmoji,
  type Reactions,
  type Report,
  type ReportItem,
  type ReportStatus,
} from '../shared/forum.ts'
import type { ClubMember, Me } from '../shared/protocol.ts'
import { TokenBuckets } from './rate-limit.ts'
import { moderatesForum } from './roles.ts'
import { ClubError } from './service.ts'
import type { Sql, SqlValue } from './store.ts'

/**
 * The club forum (TKU-BridgeHall E11: e11-t06, e11-t07; this repo's E13) in the Durable Object's
 * SQLite database (ARCHITECTURE.md §5.7). Five tables:
 *
 * - `forum_boards`: the boards; the four built-in ones (`BUILTIN_BOARDS`) are added when missing,
 *   so an admin's renaming and reordering stay
 * - `forum_posts`: a post's blocks and mentions as JSON; `pinned_at` orders the pinned posts
 *   (newest pin first) and is `Board.pinnedPostIds`; `comment_count` is kept with the comments
 * - `forum_comments`: one level deep, `parent_id` is always a top comment
 * - `forum_reactions`: one row per member and post or comment (one reaction each, AC-11.4)
 * - `forum_reports`: members' reports, for the officers (e11-t09); deleting what a report is about
 *   closes it as `removed`
 *
 * Who may use each route is roles.ts `forumRouteNeed`; who may change a given post or comment, and
 * post on an officers-only board, is checked here (`moderatesForum`). Posting and commenting are
 * rate limited per member (`FORUM_LIMITS.perMinute`). Nothing is cached in memory, and nothing
 * here depends on the handbook, so the table's E13 can take the module over (AC-11.8).
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS forum_boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    sort INTEGER NOT NULL,
    post_policy TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS forum_posts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    title TEXT,
    blocks TEXT NOT NULL,
    mentions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    pinned_at INTEGER,
    locked INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    body_text TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS forum_posts_by_board ON forum_posts (board_id, created_at)',
  'CREATE INDEX IF NOT EXISTS forum_posts_by_time ON forum_posts (created_at)',
  `CREATE TABLE IF NOT EXISTS forum_comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    parent_id TEXT,
    author_id TEXT NOT NULL,
    blocks TEXT NOT NULL,
    mentions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS forum_comments_by_post ON forum_comments (post_id, created_at)',
  `CREATE TABLE IF NOT EXISTS forum_reactions (
    target TEXT NOT NULL,
    target_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (target, target_id, user_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS forum_reports (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    handled_by TEXT,
    handled_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS forum_reports_by_status ON forum_reports (status, created_at)',
]

/** Limits of the parts of a block the shared limits leave out */
const BLOCK_LIMITS = {
  captionMax: 200,
  altMax: 200,
  labelMax: 40,
  alertMax: 200,
  /** Rules nest at most this deep, and have at most this many items in all */
  rulesDepth: 3,
  rulesItems: 60,
  /** An auction's calls (a long one is about 30) */
  callsMax: 120,
  idMax: 64,
}

const BOARD_ID = /^[a-z0-9][a-z0-9-]{0,19}$/
/** BridgeHall's forum pages next to `/forum/:boardId` (e11-t17, e11-t18), so no board may take them */
const RESERVED_BOARD_IDS = ['new', 'p', 'manage', 'reports', 'search', 'mine', 'mentions']
const REF_ID = /^[\w-]{1,64}$/
const VULNERABILITIES = ['None', 'NS', 'EW', 'Both']

export type ForumTarget = 'post' | 'comment'

/** Which posts `feed` lists (e11-t10): a member's own, or those a member is mentioned in */
export interface ForumFeedFilter {
  author?: string
  mentions?: string
}

export interface ForumDeps {
  now: () => number
  newId: () => string
  /** Every member, for reading `@` mentions */
  members: () => ClubMember[]
}

interface BoardRow extends Record<string, SqlValue> {
  id: string
  name: string
  description: string
  sort: number
  post_policy: string
}

interface PostRow extends Record<string, SqlValue> {
  id: string
  board_id: string
  author_id: string
  title: string | null
  blocks: string
  mentions: string
  created_at: number
  edited_at: number | null
  pinned_at: number | null
  locked: number
  comment_count: number
}

interface ReportRow extends Record<string, SqlValue> {
  id: string
  target: string
  target_id: string
  reporter_id: string
  reason: string
  created_at: number
  status: string
  handled_by: string | null
  handled_at: number | null
}

interface CommentRow extends Record<string, SqlValue> {
  id: string
  post_id: string
  parent_id: string | null
  author_id: string
  blocks: string
  mentions: string
  created_at: number
  edited_at: number | null
}

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A string of at most `max` characters, trimmed; `what` names it in the error */
function text(value: unknown, max: number, what: string, required = true): string {
  if (typeof value !== 'string') return fail(`${what}要是文字`)
  const clean = value.trim()
  if (required && !clean) fail(`${what}不能是空的`)
  if ([...clean].length > max) fail(`${what}最多 ${max} 字`)
  return clean
}

const optionalText = (value: unknown, max: number, what: string) =>
  value === undefined || value === null || value === '' ? undefined : text(value, max, what, false) || undefined

const length = (value: string) => [...value].length

// ── Mentions ─────────────────────────────────────────────────────────────────────────────────

/**
 * The members `@` names in these texts, by username (any case) or display name, in the order they
 * first appear. The longest name wins (`@Amy Lee` over `@Amy`); a name that ends in a Latin letter
 * or digit must not run on into more of them (`@amyx` is not `@amy`), but Chinese has no spaces
 * (`@艾咪你好` names 艾咪). An `@` inside an e-mail address names nobody.
 */
export function mentionsIn(texts: readonly string[], members: readonly ClubMember[]): string[] {
  const names = members
    .flatMap((m) => [
      { id: m.id, name: m.username.toLowerCase() },
      ...(m.displayName ? [{ id: m.id, name: m.displayName.toLowerCase() }] : []),
    ])
    .filter((n) => n.name)
    .sort((a, b) => b.name.length - a.name.length)
  const found: string[] = []
  for (const value of texts) {
    const lower = value.toLowerCase()
    for (let at = lower.indexOf('@'); at >= 0; at = lower.indexOf('@', at + 1)) {
      // Not an e-mail address
      if (at > 0 && /[a-z0-9_.]/.test(lower[at - 1])) continue
      const rest = lower.slice(at + 1)
      const hit = names.find(({ name }) => rest.startsWith(name) && !(/\w$/.test(name) && /^\w/.test(rest.slice(name.length))))
      if (hit && !found.includes(hit.id)) found.push(hit.id)
    }
  }
  return found
}

/**
 * What a post is called in a report or a notification (e11-t08, e11-t09): its title, else the start
 * of its words, at most FORUM_LIMITS.excerptMax characters
 */
export function postExcerpt(post: { title?: string; blocks: readonly PostBlock[] }): string {
  const words = post.title || post.blocks.flatMap(blockTexts).join(' ').replace(/\s+/g, ' ').trim()
  const chars = [...words]
  return chars.length > FORUM_LIMITS.excerptMax ? `${chars.slice(0, FORUM_LIMITS.excerptMax - 1).join('')}…` : words
}

/** A post's searchable words (e11-t10): its text blocks' (paragraphs, notes, lists), one a line */
const searchText = (blocks: readonly PostBlock[]) => blocks.flatMap(blockTexts).join('\n')

/** `value` as a LIKE pattern matching it anywhere; `!` escapes (`ESCAPE '!'`) */
const containing = (value: string) => `%${value.replace(/[!%_]/g, (c) => `!${c}`)}%`

// ── Blocks ───────────────────────────────────────────────────────────────────────────────────

/** A block's own words, for the text limit and mentions (captions, alerts and alt text have their own limits) */
function blockTexts(block: PostBlock): string[] {
  if (block.kind === 'paragraph' || block.kind === 'note') return [block.text]
  if (block.kind === 'rules') {
    const all: string[] = []
    const walk = (items: ForumRuleItem[]) =>
      items.forEach((item) => {
        all.push(item.text)
        if (item.children) walk(item.children)
      })
    walk(block.items)
    return all
  }
  return []
}

function checkCards(value: unknown, what: string, seen: Set<Card>): Card[] {
  if (!Array.isArray(value)) return fail(`${what}要是牌的清單`)
  if (value.length > 13) fail(`${what}最多 13 張`)
  return value.map((card) => {
    if (!isCard(card)) return fail(`${what}有不認得的牌：${String(card)}`)
    if (seen.has(card)) fail(`${card} 出現了兩次`)
    seen.add(card)
    return card
  })
}

function checkRules(value: unknown, depth: number, count: { n: number }): ForumRuleItem[] {
  if (!Array.isArray(value) || value.length === 0) return fail('條列要至少有一項')
  if (depth > BLOCK_LIMITS.rulesDepth) fail(`條列最多 ${BLOCK_LIMITS.rulesDepth} 層`)
  return value.map((item) => {
    if (!isObject(item)) return fail('條列的每一項要有文字')
    if (++count.n > BLOCK_LIMITS.rulesItems) fail(`條列最多 ${BLOCK_LIMITS.rulesItems} 項`)
    const clean: ForumRuleItem = { text: text(item.text, FORUM_LIMITS.postTextMax, '條列的文字') }
    if (item.children !== undefined) clean.children = checkRules(item.children, depth + 1, count)
    return clean
  })
}

function checkAuction(value: unknown) {
  if (!isObject(value) || !isSeat(value.dealer)) return fail('叫牌過程要有發牌者')
  const dealer = value.dealer as Seat
  if (!Array.isArray(value.calls) || value.calls.length === 0) return fail('叫牌過程要至少有一個叫品')
  if (value.calls.length > BLOCK_LIMITS.callsMax) fail(`叫牌過程最多 ${BLOCK_LIMITS.callsMax} 個叫品`)
  const calls: ForumAuctionCall[] = []
  for (const entry of value.calls as unknown[]) {
    if (!isObject(entry) || !isCall(entry.call)) return fail('叫牌過程有不認得的叫品')
    const seat = SEATS[(SEATS.indexOf(dealer) + calls.length) % 4]
    if (entry.seat !== seat) fail(`第 ${calls.length + 1} 個叫品應該是 ${seat} 叫的`)
    if (!legalCalls(calls, dealer).has(entry.call)) fail(`第 ${calls.length + 1} 個叫品 ${entry.call} 不合規則`)
    const call: ForumAuctionCall = { seat, call: entry.call }
    if (entry.alert !== undefined) call.alert = text(entry.alert, BLOCK_LIMITS.alertMax, '叫品的說明', false)
    calls.push(call)
  }
  return { dealer, calls }
}

function withCaption<T extends object>(block: T, caption: unknown): T & { caption?: string } {
  const clean = optionalText(caption, BLOCK_LIMITS.captionMax, '說明')
  return clean ? { ...block, caption: clean } : block
}

/** One block as stored: only the fields its kind has, checked */
function checkBlock(value: unknown, kinds: readonly string[]): PostBlock {
  if (!isObject(value) || typeof value.kind !== 'string' || !kinds.includes(value.kind)) return fail(`不認得的區塊：${String(isObject(value) ? value.kind : value)}`)
  switch (value.kind) {
    case 'paragraph':
      return { kind: 'paragraph', text: text(value.text, FORUM_LIMITS.postTextMax, '段落') }
    case 'note':
      if (value.tone !== 'info' && value.tone !== 'warning') fail('提示的語氣（tone）要是 info 或 warning')
      return { kind: 'note', tone: value.tone as 'info' | 'warning', text: text(value.text, FORUM_LIMITS.postTextMax, '提示') }
    case 'rules': {
      const block: PostBlock = { kind: 'rules', items: checkRules(value.items, 1, { n: 0 }) }
      if (value.ordered !== undefined) {
        if (typeof value.ordered !== 'boolean') fail('編號（ordered）要是 true 或 false')
        if (value.ordered) block.ordered = true
      }
      return block
    }
    case 'hand': {
      const cards = checkCards(value.cards, '單手牌', new Set())
      if (cards.length === 0) fail('單手牌要至少有一張牌')
      const label = optionalText(value.label, BLOCK_LIMITS.labelMax, '單手牌的標籤')
      return label ? { kind: 'hand', cards, label } : { kind: 'hand', cards }
    }
    case 'deal': {
      const deal = value.deal
      if (!isObject(deal) || !isObject(deal.hands)) return fail('四家牌要有四家的牌')
      if (!isSeat(deal.dealer)) fail('四家牌要有發牌者')
      if (!VULNERABILITIES.includes(deal.vul as string)) fail('四家牌的身價要是 None、NS、EW 或 Both')
      const seen = new Set<Card>()
      const handsIn = deal.hands
      const hands = { N: [], E: [], S: [], W: [] } as Record<Seat, Card[]>
      for (const seat of SEATS) hands[seat] = checkCards(handsIn[seat] ?? [], `${seat} 家的牌`, seen)
      if (seen.size === 0) fail('四家牌要至少有一張牌')
      return withCaption({ kind: 'deal' as const, deal: { hands, dealer: deal.dealer as Seat, vul: deal.vul as 'None' } }, value.caption)
    }
    case 'auction':
      return withCaption({ kind: 'auction' as const, auction: checkAuction(value.auction) }, value.caption)
    case 'image': {
      if (typeof value.assetId !== 'string' || !FILE_KEY.test(value.assetId) || !value.assetId.startsWith('post/'))
        return fail('圖片要先上傳（assetId）')
      const alt = text(value.alt ?? '', BLOCK_LIMITS.altMax, '圖片的替代文字', false)
      return withCaption({ kind: 'image' as const, assetId: value.assetId, alt }, value.caption)
    }
    case 'ref': {
      if (typeof value.slug !== 'string' || !REF_ID.test(value.slug)) return fail('特約引用要有特約代號（slug）')
      if (value.sectionId !== undefined && (typeof value.sectionId !== 'string' || !REF_ID.test(value.sectionId)))
        fail('特約引用的段落代號（sectionId）不正確')
      return value.sectionId ? { kind: 'ref', slug: value.slug, sectionId: value.sectionId as string } : { kind: 'ref', slug: value.slug }
    }
    case 'record':
      if (typeof value.tableRecordId !== 'string' || !REF_ID.test(value.tableRecordId)) return fail('牌桌紀錄引用要有紀錄代號')
      return { kind: 'record', tableRecordId: value.tableRecordId }
  }
  return fail(`不認得的區塊：${value.kind}`)
}

/** A post's or a comment's blocks, checked against the limits; `textMax` is for all their words together */
function checkBlocks(value: unknown, kinds: readonly string[], textMax: number): PostBlock[] {
  if (!Array.isArray(value) || value.length === 0) return fail('內容要至少有一個區塊')
  if (value.length > FORUM_LIMITS.blocksMax) fail(`最多 ${FORUM_LIMITS.blocksMax} 個區塊`)
  const blocks = value.map((block) => checkBlock(block, kinds))
  const words = blocks.flatMap(blockTexts).reduce((sum, t) => sum + length(t), 0)
  if (words > textMax) fail(`文字最多 ${textMax} 字（現在 ${words} 字）`)
  if (blocks.filter((b) => b.kind === 'image').length > FORUM_LIMITS.imagesMax) fail(`圖片最多 ${FORUM_LIMITS.imagesMax} 張`)
  return blocks
}

const POST_KINDS = ['paragraph', 'rules', 'note', 'hand', 'deal', 'auction', 'image', 'ref', 'record']

// ── The service ──────────────────────────────────────────────────────────────────────────────

const POST_COLUMNS = 'id, board_id, author_id, title, blocks, mentions, created_at, edited_at, pinned_at, locked, comment_count'
const COMMENT_COLUMNS = 'id, post_id, parent_id, author_id, blocks, mentions, created_at, edited_at'

export class ForumService {
  private readonly sql: Sql
  private readonly deps: ForumDeps
  /** Posts and comments per member: FORUM_LIMITS.perMinute at once, then that many a minute */
  private readonly writes: TokenBuckets

  constructor(sql: Sql, deps: ForumDeps) {
    this.sql = sql
    this.deps = deps
    this.writes = new TokenBuckets(FORUM_LIMITS.perMinute, FORUM_LIMITS.perMinute / 60, deps.now)
  }

  /** The tables, and the built-in boards that are missing */
  createTables() {
    for (const statement of SCHEMA) this.sql.exec(statement)
    // Search (e11-t10) keeps each post's words in a column of their own; posts from before it get theirs here, once
    const columns = this.sql.exec<{ name: string }>('PRAGMA table_info(forum_posts)').map((c) => c.name)
    if (!columns.includes('body_text')) this.sql.exec('ALTER TABLE forum_posts ADD COLUMN body_text TEXT')
    for (const row of this.sql.exec<{ id: string; blocks: string }>('SELECT id, blocks FROM forum_posts WHERE body_text IS NULL'))
      this.sql.exec('UPDATE forum_posts SET body_text = ? WHERE id = ?', searchText(JSON.parse(row.blocks) as PostBlock[]), row.id)
    for (const board of BUILTIN_BOARDS)
      this.sql.exec(
        'INSERT OR IGNORE INTO forum_boards (id, name, description, sort, post_policy) VALUES (?, ?, ?, ?, ?)',
        board.id,
        board.name,
        board.description,
        board.order,
        board.postPolicy,
      )
  }

  // ── Boards ─────────────────────────────────────────────────────────────────────────────────

  /** Every board, in order */
  boards(): Board[] {
    return this.sql.exec<BoardRow>('SELECT * FROM forum_boards ORDER BY sort, id').map((row) => this.toBoard(row))
  }

  board(id: string): Board {
    const [row] = this.sql.exec<BoardRow>('SELECT * FROM forum_boards WHERE id = ?', id)
    if (!row) throw new ClubError('forumBoardGone', {}, 404)
    return this.toBoard(row)
  }

  /** An admin adds a board (the route checks that); after the others unless `order` says where */
  createBoard(body: unknown): Board {
    if (!isObject(body)) return fail('不是一個板面')
    const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM forum_boards')[0].n
    if (count >= FORUM_LIMITS.boardsMax) throw new ClubError('forumBoardLimit', { max: FORUM_LIMITS.boardsMax }, 409)
    const last = this.sql.exec<{ sort: number | null }>('SELECT MAX(sort) AS sort FROM forum_boards')[0].sort
    const board = {
      name: text(body.name, FORUM_LIMITS.boardNameMax, '板面名稱'),
      description: text(body.description ?? '', FORUM_LIMITS.boardDescriptionMax, '板面說明', false),
      order: body.order === undefined ? (last ?? -1) + 1 : this.checkOrder(body.order),
      postPolicy: body.postPolicy === undefined ? 'all' : this.checkPolicy(body.postPolicy),
    }
    let id: string
    if (body.id !== undefined) {
      if (typeof body.id !== 'string' || !BOARD_ID.test(body.id)) return fail('板面代號只能用小寫英文、數字與 -，最多 20 字')
      id = body.id
      if (RESERVED_BOARD_IDS.includes(id)) fail(`板面代號不能用 ${id}`)
      if (this.sql.exec('SELECT id FROM forum_boards WHERE id = ?', id).length) throw new ClubError('forumBoardExists', {}, 409)
    } else {
      do id = this.deps.newId()
      while (this.sql.exec('SELECT id FROM forum_boards WHERE id = ?', id).length)
    }
    this.sql.exec(
      'INSERT INTO forum_boards (id, name, description, sort, post_policy) VALUES (?, ?, ?, ?, ?)',
      id,
      board.name,
      board.description,
      board.order,
      board.postPolicy,
    )
    return this.board(id)
  }

  /** Renames, describes, moves or opens up a board (an admin's) */
  updateBoard(id: string, body: unknown): Board {
    const board = this.board(id)
    if (!isObject(body)) return fail('不是一個板面')
    if (body.id !== undefined && body.id !== id) fail('板面代號不能改')
    const name = body.name === undefined ? board.name : text(body.name, FORUM_LIMITS.boardNameMax, '板面名稱')
    const description =
      body.description === undefined ? board.description : text(body.description, FORUM_LIMITS.boardDescriptionMax, '板面說明', false)
    const order = body.order === undefined ? board.order : this.checkOrder(body.order)
    const postPolicy = body.postPolicy === undefined ? board.postPolicy : this.checkPolicy(body.postPolicy)
    this.sql.exec(
      'UPDATE forum_boards SET name = ?, description = ?, sort = ?, post_policy = ? WHERE id = ?',
      name,
      description,
      order,
      postPolicy,
      id,
    )
    return this.board(id)
  }

  /** Only an empty board that is not built in */
  deleteBoard(id: string) {
    this.board(id)
    if (BUILTIN_BOARDS.some((b) => b.id === id)) throw new ClubError('forumBoardBuiltIn', {}, 409)
    if (this.sql.exec('SELECT id FROM forum_posts WHERE board_id = ? LIMIT 1', id).length) throw new ClubError('forumBoardNotEmpty', {}, 409)
    this.sql.exec('DELETE FROM forum_boards WHERE id = ?', id)
  }

  /** One page of a board: its pinned posts on page 1, then the others newest first, FORUM_LIMITS.pageSize a page */
  boardPage(id: string, page = 1): BoardPage {
    const board = this.board(id)
    const at = Number.isInteger(page) && page > 0 ? page : 1
    const total = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM forum_posts WHERE board_id = ? AND pinned_at IS NULL', id)[0].n
    const rows = this.sql.exec<PostRow>(
      `SELECT ${POST_COLUMNS} FROM forum_posts WHERE board_id = ? AND pinned_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      id,
      FORUM_LIMITS.pageSize,
      (at - 1) * FORUM_LIMITS.pageSize,
    )
    const pinned =
      at === 1
        ? this.sql.exec<PostRow>(`SELECT ${POST_COLUMNS} FROM forum_posts WHERE board_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC`, id)
        : []
    return {
      board,
      pinned: this.toPosts(pinned),
      posts: this.toPosts(rows),
      page: at,
      pages: Math.max(1, Math.ceil(total / FORUM_LIMITS.pageSize)),
    }
  }

  /**
   * The forum's front page (BridgeHall e11-t15): every board's posts newest first, FORUM_LIMITS.pageSize
   * a page. `author`: only that member's posts (我的貼文); `mentions`: only posts that member is
   * `@`-mentioned in, in the post or one of its comments (我提到的)
   */
  feed(page = 1, filter: ForumFeedFilter = {}): ForumFeed {
    const where: string[] = []
    const params: SqlValue[] = []
    if (filter.author !== undefined) {
      where.push('author_id = ?')
      params.push(filter.author)
    }
    if (filter.mentions !== undefined) {
      const quoted = containing(JSON.stringify(filter.mentions))
      where.push(`(mentions LIKE ? ESCAPE '!' OR id IN (SELECT post_id FROM forum_comments WHERE mentions LIKE ? ESCAPE '!'))`)
      params.push(quoted, quoted)
    }
    const { total: _, ...found } = this.postsPage(where, params, page)
    return found
  }

  /**
   * 搜尋 (e11-t10): posts whose title or text blocks hold every word of `query` (split at spaces,
   * case-insensitive for Latin letters), newest first, FORUM_LIMITS.pageSize a page. Comments,
   * captions and alt text are not searched.
   */
  search(query: unknown, page = 1): ForumSearch {
    const words = typeof query === 'string' ? [...new Set(query.trim().split(/\s+/).filter(Boolean))] : []
    const joined = words.join(' ')
    if (!words.length || words.length > FORUM_LIMITS.searchWordsMax || length(joined) > FORUM_LIMITS.searchMax)
      fail(`搜尋要 1 到 ${FORUM_LIMITS.searchMax} 字、最多 ${FORUM_LIMITS.searchWordsMax} 個詞`)
    const where = words.map(() => `(title LIKE ? ESCAPE '!' OR body_text LIKE ? ESCAPE '!')`)
    const params = words.flatMap((word) => [containing(word), containing(word)])
    const { total, ...found } = this.postsPage(where, params, page)
    return { ...found, query: joined, total }
  }

  /** One page of the posts `where` (ANDed) picks, newest first, and how many there are */
  private postsPage(where: string[], params: SqlValue[], page: number): ForumFeed & { total: number } {
    const at = Number.isInteger(page) && page > 0 ? page : 1
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM forum_posts ${clause}`, ...params)[0].n
    const rows = this.sql.exec<PostRow>(
      `SELECT ${POST_COLUMNS} FROM forum_posts ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      ...params,
      FORUM_LIMITS.pageSize,
      (at - 1) * FORUM_LIMITS.pageSize,
    )
    return { posts: this.toPosts(rows), page: at, pages: Math.max(1, Math.ceil(total / FORUM_LIMITS.pageSize)), total }
  }

  /** The home page's two lists (e11-t16): the news board pinned first, and the newest of the others */
  latest(): ForumLatest {
    const news = this.sql.exec<PostRow>(
      `SELECT ${POST_COLUMNS} FROM forum_posts WHERE board_id = ?
       ORDER BY pinned_at IS NULL, pinned_at DESC, created_at DESC, rowid DESC LIMIT ?`,
      NEWS_BOARD_ID,
      FORUM_LIMITS.latestShown,
    )
    const discussions = this.sql.exec<PostRow>(
      `SELECT ${POST_COLUMNS} FROM forum_posts WHERE board_id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      NEWS_BOARD_ID,
      FORUM_LIMITS.latestShown,
    )
    return { news: this.toPosts(news), discussions: this.toPosts(discussions) }
  }

  // ── Posts ──────────────────────────────────────────────────────────────────────────────────

  /** A member posts on a board; an officers-only board takes only the officers' */
  createPost(me: Me, boardId: string, body: unknown): Post {
    const board = this.board(boardId)
    if (board.postPolicy === 'officers' && !moderatesForum(me)) throw new ClubError('forumBoardOfficersOnly', {}, 403)
    const { title, blocks } = this.checkPost(body)
    this.takeWrite(me.id)
    let id: string
    do id = this.deps.newId()
    while (this.sql.exec('SELECT id FROM forum_posts WHERE id = ?', id).length)
    this.sql.exec(
      'INSERT INTO forum_posts (id, board_id, author_id, title, blocks, mentions, created_at, body_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      boardId,
      me.id,
      title ?? null,
      JSON.stringify(blocks),
      JSON.stringify(this.mentions(blocks)),
      this.deps.now(),
      searchText(blocks),
    )
    return this.post(id)
  }

  post(id: string): Post {
    return this.toPosts([this.postRow(id)])[0]
  }

  /** A post and all its comments, oldest first */
  thread(id: string): PostThread {
    const post = this.post(id)
    const rows = this.sql.exec<CommentRow>(`SELECT ${COMMENT_COLUMNS} FROM forum_comments WHERE post_id = ? ORDER BY created_at, rowid`, id)
    return { post, comments: this.toComments(rows) }
  }

  /** Only its author edits a post: title and blocks */
  updatePost(me: Me, id: string, body: unknown): Post {
    const row = this.postRow(id)
    if (row.author_id !== me.id) throw new ClubError('notYours', {}, 403)
    const { title, blocks } = this.checkPost(body)
    this.sql.exec(
      'UPDATE forum_posts SET title = ?, blocks = ?, mentions = ?, edited_at = ?, body_text = ? WHERE id = ?',
      title ?? null,
      JSON.stringify(blocks),
      JSON.stringify(this.mentions(blocks)),
      this.deps.now(),
      searchText(blocks),
      id,
    )
    return this.post(id)
  }

  /** Its author or an officer deletes a post, with its comments and every reaction to them */
  deletePost(me: Me, id: string) {
    const row = this.postRow(id)
    if (row.author_id !== me.id && !moderatesForum(me)) throw new ClubError('notYours', {}, 403)
    this.sql.transaction(() => {
      this.sql.exec(
        "DELETE FROM forum_reactions WHERE target = 'comment' AND target_id IN (SELECT id FROM forum_comments WHERE post_id = ?)",
        id,
      )
      this.sql.exec("DELETE FROM forum_reactions WHERE target = 'post' AND target_id = ?", id)
      const comments = this.sql.exec<{ id: string }>('SELECT id FROM forum_comments WHERE post_id = ?', id).map((r) => r.id)
      this.closeReports('comment', comments, 'removed', me.id)
      this.closeReports('post', [id], 'removed', me.id)
      this.sql.exec('DELETE FROM forum_comments WHERE post_id = ?', id)
      this.sql.exec('DELETE FROM forum_posts WHERE id = ?', id)
    })
  }

  /** An officer pins a post above the board's others (the newest pin first) or takes it down: `{ pinned }` */
  setPinned(id: string, body: unknown): Post {
    const row = this.postRow(id)
    const pinned = this.flag(body, 'pinned')
    if (pinned !== (row.pinned_at !== null)) this.sql.exec('UPDATE forum_posts SET pinned_at = ? WHERE id = ?', pinned ? this.deps.now() : null, id)
    return this.post(id)
  }

  /** An officer locks a post (no new comments) or opens it again: `{ locked }` */
  setLocked(id: string, body: unknown): Post {
    this.postRow(id)
    this.sql.exec('UPDATE forum_posts SET locked = ? WHERE id = ?', this.flag(body, 'locked') ? 1 : 0, id)
    return this.post(id)
  }

  // ── Comments (e11-t07) ─────────────────────────────────────────────────────────────────────

  /**
   * A member comments on a post, or replies to a comment (`parentId`): a reply to a reply hangs
   * under the same top comment. A locked post takes only the officers' comments.
   */
  addComment(me: Me, postId: string, body: unknown): Comment {
    const post = this.postRow(postId)
    if (post.locked && !moderatesForum(me)) throw new ClubError('postLocked', {}, 409)
    if (!isObject(body)) return fail('不是一則留言')
    let parentId: string | null = null
    if (body.parentId !== undefined && body.parentId !== null) {
      if (typeof body.parentId !== 'string') return fail('回覆的留言（parentId）不正確')
      const parent = this.commentRow(body.parentId)
      if (parent.post_id !== postId) fail('回覆的留言不在這篇貼文')
      parentId = parent.parent_id ?? parent.id
    }
    const blocks = checkBlocks(body.blocks, COMMENT_BLOCK_KINDS, FORUM_LIMITS.commentTextMax) as CommentBlock[]
    this.takeWrite(me.id)
    let id: string
    do id = this.deps.newId()
    while (this.sql.exec('SELECT id FROM forum_comments WHERE id = ?', id).length)
    this.sql.transaction(() => {
      this.sql.exec(
        'INSERT INTO forum_comments (id, post_id, parent_id, author_id, blocks, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        postId,
        parentId,
        me.id,
        JSON.stringify(blocks),
        JSON.stringify(this.mentions(blocks)),
        this.deps.now(),
      )
      this.sql.exec('UPDATE forum_posts SET comment_count = comment_count + 1 WHERE id = ?', postId)
    })
    return this.comment(id)
  }

  comment(id: string): Comment {
    return this.toComments([this.commentRow(id)])[0]
  }

  /** Only its author edits a comment: its blocks */
  updateComment(me: Me, id: string, body: unknown): Comment {
    const row = this.commentRow(id)
    if (row.author_id !== me.id) throw new ClubError('notYours', {}, 403)
    if (!isObject(body)) return fail('不是一則留言')
    const blocks = checkBlocks(body.blocks, COMMENT_BLOCK_KINDS, FORUM_LIMITS.commentTextMax)
    this.sql.exec(
      'UPDATE forum_comments SET blocks = ?, mentions = ?, edited_at = ? WHERE id = ?',
      JSON.stringify(blocks),
      JSON.stringify(this.mentions(blocks)),
      this.deps.now(),
      id,
    )
    return this.comment(id)
  }

  /** Its author or an officer deletes a comment; a top comment's replies go with it */
  deleteComment(me: Me, id: string) {
    const row = this.commentRow(id)
    if (row.author_id !== me.id && !moderatesForum(me)) throw new ClubError('notYours', {}, 403)
    this.sql.transaction(() => {
      const ids = [id, ...this.sql.exec<{ id: string }>('SELECT id FROM forum_comments WHERE parent_id = ?', id).map((r) => r.id)]
      this.closeReports('comment', ids, 'removed', me.id)
      for (const gone of ids) {
        this.sql.exec("DELETE FROM forum_reactions WHERE target = 'comment' AND target_id = ?", gone)
        this.sql.exec('DELETE FROM forum_comments WHERE id = ?', gone)
      }
      this.sql.exec('UPDATE forum_posts SET comment_count = MAX(0, comment_count - ?) WHERE id = ?', ids.length, row.post_id)
    })
  }

  // ── Reactions (e11-t07) ────────────────────────────────────────────────────────────────────

  /** A member's one reaction to a post or a comment: `{ emoji }` replaces the one they had */
  react(me: Me, target: ForumTarget, id: string, body: unknown): Reactions {
    this.requireTarget(target, id)
    const emoji = isObject(body) ? body.emoji : undefined
    if (!REACTION_EMOJIS.includes(emoji as ReactionEmoji)) return fail(`反應要是 ${REACTION_EMOJIS.join(' ')} 其中一個`)
    this.sql.exec(
      `INSERT INTO forum_reactions (target, target_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (target, target_id, user_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at
       WHERE forum_reactions.emoji != excluded.emoji`,
      target,
      id,
      me.id,
      emoji as string,
      this.deps.now(),
    )
    return this.reactionsOf(target, [id]).get(id) ?? {}
  }

  /** Takes a member's reaction back */
  unreact(me: Me, target: ForumTarget, id: string): Reactions {
    this.requireTarget(target, id)
    this.sql.exec('DELETE FROM forum_reactions WHERE target = ? AND target_id = ? AND user_id = ?', target, id, me.id)
    return this.reactionsOf(target, [id]).get(id) ?? {}
  }

  // ── Reports (e11-t09) ──────────────────────────────────────────────────────────────────────

  /**
   * A member reports someone else's post or comment to the officers. Reporting the same one again
   * while the first is open changes its reason; a member has at most FORUM_LIMITS.reportsOpenMax open
   */
  fileReport(me: Me, body: unknown): Report {
    if (!isObject(body)) return fail('不是一則檢舉')
    const target = body.target
    if (target !== 'post' && target !== 'comment') return fail('檢舉的對象（target）要是 post 或 comment')
    if (typeof body.targetId !== 'string') return fail('檢舉要指出哪一篇貼文或留言（targetId）')
    const targetId = body.targetId
    const author = target === 'post' ? this.postRow(targetId).author_id : this.commentRow(targetId).author_id
    if (author === me.id) fail('不能檢舉自己的貼文或留言')
    const reason = text(body.reason, FORUM_LIMITS.reportReasonMax, '檢舉的原因')
    const [open] = this.sql.exec<ReportRow>(
      "SELECT * FROM forum_reports WHERE target = ? AND target_id = ? AND reporter_id = ? AND status = 'open'",
      target,
      targetId,
      me.id,
    )
    if (open) {
      this.sql.exec('UPDATE forum_reports SET reason = ? WHERE id = ?', reason, open.id)
      return this.report(open.id)
    }
    const mine = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM forum_reports WHERE reporter_id = ? AND status = 'open'", me.id)[0].n
    if (mine >= FORUM_LIMITS.reportsOpenMax) throw new ClubError('forumReportLimit', { max: FORUM_LIMITS.reportsOpenMax }, 409)
    let id: string
    do id = this.deps.newId()
    while (this.sql.exec('SELECT id FROM forum_reports WHERE id = ?', id).length)
    this.sql.exec(
      "INSERT INTO forum_reports (id, target, target_id, reporter_id, reason, created_at, status) VALUES (?, ?, ?, ?, ?, ?, 'open')",
      id,
      target,
      targetId,
      me.id,
      reason,
      this.deps.now(),
    )
    return this.report(id)
  }

  report(id: string): Report {
    return this.toReport(this.reportRow(id))
  }

  /** The officers' list: open reports, or every report (`all`), newest first, with what each one reported */
  reports(status: 'open' | 'all' = 'open'): ReportItem[] {
    const rows =
      status === 'all'
        ? this.sql.exec<ReportRow>('SELECT * FROM forum_reports ORDER BY created_at DESC, rowid DESC LIMIT ?', FORUM_LIMITS.reportsShown)
        : this.sql.exec<ReportRow>(
            "SELECT * FROM forum_reports WHERE status = 'open' ORDER BY created_at DESC, rowid DESC LIMIT ?",
            FORUM_LIMITS.reportsShown,
          )
    return rows.map((row) => ({ report: this.toReport(row), ...this.reported(row.target as ForumTarget, row.target_id) }))
  }

  /**
   * An officer handles an open report: dismisses it, or removes what it reported. Either way every
   * open report of the same post or comment closes with it. The answer also says what was reported,
   * for the audit log.
   */
  decideReport(me: Me, id: string, body: unknown): { report: Report; reported: Omit<ReportItem, 'report'> } {
    const row = this.reportRow(id)
    if (row.status !== 'open') throw new ClubError('forumReportHandled', {}, 409)
    const action = isObject(body) ? body.action : undefined
    if (action !== 'dismiss' && action !== 'remove') return fail('處理方式（action）要是 dismiss 或 remove')
    const target = row.target as ForumTarget
    const reported = this.reported(target, row.target_id)
    if (action === 'remove' && reported.postId) {
      // As an officer: deleting closes this report and the others of it as removed
      if (target === 'post') this.deletePost(me, row.target_id)
      else this.deleteComment(me, row.target_id)
    } else this.closeReports(target, [row.target_id], action === 'remove' ? 'removed' : 'dismissed', me.id)
    return { report: this.report(id), reported }
  }

  /** What a report is about as it is now; nothing when it was deleted since */
  private reported(target: ForumTarget, id: string): Omit<ReportItem, 'report'> {
    const [comment] = target === 'comment' ? this.sql.exec<CommentRow>(`SELECT ${COMMENT_COLUMNS} FROM forum_comments WHERE id = ?`, id) : []
    const postId = target === 'post' ? id : comment?.post_id
    const [post] = postId ? this.sql.exec<PostRow>(`SELECT ${POST_COLUMNS} FROM forum_posts WHERE id = ?`, postId) : []
    if (!post) return {}
    if (target === 'post')
      return {
        postId: post.id,
        authorId: post.author_id,
        excerpt: postExcerpt({ title: post.title ?? undefined, blocks: JSON.parse(post.blocks) as PostBlock[] }),
      }
    return { postId: post.id, authorId: comment.author_id, excerpt: postExcerpt({ blocks: JSON.parse(comment.blocks) as PostBlock[] }) }
  }

  private closeReports(target: ForumTarget, ids: string[], status: Exclude<ReportStatus, 'open'>, by: string) {
    for (const id of ids)
      this.sql.exec(
        "UPDATE forum_reports SET status = ?, handled_by = ?, handled_at = ? WHERE target = ? AND target_id = ? AND status = 'open'",
        status,
        by,
        this.deps.now(),
        target,
        id,
      )
  }

  private reportRow(id: string): ReportRow {
    const [row] = id.length <= BLOCK_LIMITS.idMax ? this.sql.exec<ReportRow>('SELECT * FROM forum_reports WHERE id = ?', id) : []
    if (!row) throw new ClubError('forumReportGone', {}, 404)
    return row
  }

  private toReport(row: ReportRow): Report {
    const report: Report = {
      id: row.id,
      target: row.target as ForumTarget,
      targetId: row.target_id,
      reporterId: row.reporter_id,
      reason: row.reason,
      createdAt: row.created_at,
      status: row.status as ReportStatus,
    }
    if (row.handled_by) report.handledBy = row.handled_by
    if (row.handled_at !== null) report.handledAt = row.handled_at
    return report
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────

  private checkOrder(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 999) return fail('排序（order）要是 0 到 999 的整數')
    return value as number
  }

  private checkPolicy(value: unknown): BoardPostPolicy {
    if (!BOARD_POST_POLICIES.includes(value as BoardPostPolicy)) return fail('發文權限（postPolicy）要是 all 或 officers')
    return value as BoardPostPolicy
  }

  private checkPost(body: unknown): { title?: string; blocks: PostBlock[] } {
    if (!isObject(body)) return fail('不是一篇貼文')
    const title = optionalText(body.title, FORUM_LIMITS.titleMax, '標題')
    return { title, blocks: checkBlocks(body.blocks, POST_KINDS, FORUM_LIMITS.postTextMax) }
  }

  private flag(body: unknown, name: string): boolean {
    const value = isObject(body) ? body[name] : undefined
    if (typeof value !== 'boolean') return fail(`${name} 要是 true 或 false`)
    return value
  }

  private takeWrite(userId: string) {
    if (!this.writes.take(userId)) throw new ClubError('slowDown', {}, 429)
  }

  private mentions(blocks: PostBlock[]): string[] {
    return mentionsIn(blocks.flatMap(blockTexts), this.deps.members())
  }

  private postRow(id: string): PostRow {
    const [row] = id.length <= BLOCK_LIMITS.idMax ? this.sql.exec<PostRow>(`SELECT ${POST_COLUMNS} FROM forum_posts WHERE id = ?`, id) : []
    if (!row) throw new ClubError('postGone', {}, 404)
    return row
  }

  private commentRow(id: string): CommentRow {
    const [row] = id.length <= BLOCK_LIMITS.idMax ? this.sql.exec<CommentRow>(`SELECT ${COMMENT_COLUMNS} FROM forum_comments WHERE id = ?`, id) : []
    if (!row) throw new ClubError('commentGone', {}, 404)
    return row
  }

  private requireTarget(target: ForumTarget, id: string) {
    if (target === 'post') this.postRow(id)
    else this.commentRow(id)
  }

  private toBoard(row: BoardRow): Board {
    const pinnedPostIds = this.sql
      .exec<{ id: string }>('SELECT id FROM forum_posts WHERE board_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC', row.id)
      .map((r) => r.id)
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      order: row.sort,
      postPolicy: row.post_policy as BoardPostPolicy,
      pinnedPostIds,
    }
  }

  /** Each target's reactions, every emoji's members oldest first, emojis in REACTION_EMOJIS order */
  private reactionsOf(target: ForumTarget, ids: string[]): Map<string, Reactions> {
    const result = new Map<string, Reactions>()
    if (!ids.length) return result
    const rows = this.sql.exec<{ target_id: string; user_id: string; emoji: string }>(
      `SELECT target_id, user_id, emoji FROM forum_reactions WHERE target = ? AND target_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY created_at, user_id`,
      target,
      ...ids,
    )
    for (const row of rows) {
      const reactions = result.get(row.target_id) ?? {}
      ;(reactions[row.emoji as ReactionEmoji] ??= []).push(row.user_id)
      result.set(row.target_id, reactions)
    }
    for (const [id, reactions] of result) {
      const ordered: Reactions = {}
      for (const emoji of REACTION_EMOJIS) if (reactions[emoji]) ordered[emoji] = reactions[emoji]
      result.set(id, ordered)
    }
    return result
  }

  private toPosts(rows: PostRow[]): Post[] {
    const reactions = this.reactionsOf('post', rows.map((r) => r.id))
    return rows.map((row) => {
      const post: Post = {
        id: row.id,
        boardId: row.board_id,
        authorId: row.author_id,
        blocks: JSON.parse(row.blocks) as PostBlock[],
        createdAt: row.created_at,
        reactions: reactions.get(row.id) ?? {},
        commentCount: row.comment_count,
      }
      if (row.title) post.title = row.title
      if (row.edited_at !== null) post.editedAt = row.edited_at
      if (row.pinned_at !== null) post.pinned = true
      if (row.locked) post.locked = true
      const mentions = JSON.parse(row.mentions) as string[]
      if (mentions.length) post.mentions = mentions
      return post
    })
  }

  private toComments(rows: CommentRow[]): Comment[] {
    const reactions = this.reactionsOf('comment', rows.map((r) => r.id))
    return rows.map((row) => {
      const comment: Comment = {
        id: row.id,
        postId: row.post_id,
        authorId: row.author_id,
        blocks: JSON.parse(row.blocks) as CommentBlock[],
        createdAt: row.created_at,
        reactions: reactions.get(row.id) ?? {},
      }
      if (row.parent_id) comment.parentId = row.parent_id
      if (row.edited_at !== null) comment.editedAt = row.edited_at
      const mentions = JSON.parse(row.mentions) as string[]
      if (mentions.length) comment.mentions = mentions
      return comment
    })
  }
}
