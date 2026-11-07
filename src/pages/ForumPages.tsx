import { CalendarClock, ChevronLeft, ChevronRight, EyeOff, FilePen, Hash, Lock, MessageSquare, Pin, X } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import {
  FORUM_LIMITS,
  REACTION_EMOJIS,
  type Board,
  type BoardPage,
  type Comment,
  type CommentBlock,
  type ForumAuction,
  type ForumFeed,
  type ForumTags,
  type Post,
  type PostThread,
  type ReactionEmoji,
  type Reactions,
} from '../../shared/forum.ts'
import { emptyAuction } from '../../shared/forum-editor.ts'
import { AuctionEditor } from '../components/AuctionEditor.tsx'
import { ForumBlocks } from '../components/ForumBlocks.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle, Textarea } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { forumApi } from '../lib/forum.ts'
import { notOut } from '../lib/forumRelease.ts'
import { useMemberName, useOfficer } from '../lib/forumHooks.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { cardHover } from '../styles/controls.ts'
import { ReportForm } from './ForumModerationPages.tsx'

/**
 * 論壇 (E13 K1, `e13-t03`, ARCHITECTURE.md §5.19): the table's pages on the club forum that
 * BridgeHall's forum also shows (the same `/api/forum/*`, the same posts). Behind the `forum`
 * feature flag (App.tsx). Three pages, at the same addresses as BridgeHall's, so a link to a post
 * reads the same on both sites:
 *
 * - `/forum`: the boards and the tags in use, then every board's posts newest first, a page at a time
 * - `/forum/:boardId`: one board, its pinned posts first (page 1), then newest first
 * - `?tag=` on either: only the posts with that tag (AC-13.7); a post's tags link there
 * - `/forum/p/:postId`: the post and its comments (one level of replies); members comment, reply and
 *   react, edit their own comments and delete them (officers anyone's), and officers pin the post;
 *   the server checks all of it
 * - `/forum/drafts`: my drafts and scheduled posts, and for an officer everyone's scheduled ones (e13-t12)
 *
 * Posts are written and edited with the table's own editor (K2, `ForumEditorPage.tsx`); a comment
 * may carry an auction (`AuctionEditor`).
 */

export const Intro = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(3)};
  margin-bottom: ${({ theme }) => theme.space(5)};
`

const SectionTitle = styled.h2`
  margin: ${({ theme }) => theme.space(6)} 0 ${({ theme }) => theme.space(3)};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.h2.size};
  line-height: ${({ theme }) => theme.type.h2.line};
  font-weight: ${({ theme }) => theme.type.h2.weight};
`

const BoardGrid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Tile = styled(Link)`
  display: grid;
  gap: 4px;
  height: 100%;
  padding: 14px 16px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;
  ${cardHover()}

  & > strong {
    font-size: 16px;
  }
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
`

const PostList = styled.ul`
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  overflow: hidden;

  & > li + li {
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
`

const Row = styled(Link)`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  align-items: center;
  padding: 12px 16px;
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;

  &:hover {
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  & > strong {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  & > small {
    grid-column: 1;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
  & > ul {
    grid-column: 1;
  }
`

const Count = styled.span`
  grid-row: 1 / span 2;
  grid-column: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

export const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.accentStrong};
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
`

/** A post's tags, or the tags to filter by (AC-13.7) */
export const TagRow = styled.ul`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const tagLook = `
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 8px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  text-decoration: none;
`

export const TagChip = styled(Link)<{ $active?: boolean }>`
  ${tagLook}
  border: 1px solid ${({ theme, $active }) => ($active ? theme.colors.primary : theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $active }) => ($active ? theme.colors.accentSoft : theme.colors.surfaceAlt)};
  color: ${({ theme, $active }) => ($active ? theme.colors.accentStrong : theme.colors.textMuted)};

  &:hover {
    border-color: ${({ theme }) => theme.colors.primary};
    color: ${({ theme }) => theme.colors.primary};
  }
`

/** A tag inside a link (a post's row), so not a link itself */
const TagText = styled.span`
  ${tagLook}
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.textMuted};
`

/** Where a tag leads: the forum's posts with it, or one board's (AC-13.7) */
const tagHref = (tag: string, boardId?: string) =>
  `${boardId ? `/forum/${encodeURIComponent(boardId)}` : '/forum'}?tag=${encodeURIComponent(tag)}`

/** A post's tags as links to the posts with each one */
export function PostTags({ tags }: { tags?: readonly string[] }) {
  const { t } = usePreferences()
  if (!tags?.length) return null
  return (
    <TagRow aria-label={t.forum.tags}>
      {tags.map((tag) => (
        <li key={tag}>
          <TagChip to={tagHref(tag)} aria-label={t.forum.tagLink(tag)}>
            <Hash size={11} aria-hidden />
            {tag}
          </TagChip>
        </li>
      ))}
    </TagRow>
  )
}

/** The tag a list is filtered by, and the way back to the whole list */
function TagFilter({ tag, clear }: { tag: string; clear: string }) {
  const { t } = usePreferences()
  return (
    <FilterBar role="status">
      <TagChip to={clear} $active aria-label={t.forum.clearTag} title={t.forum.clearTag}>
        {t.forum.tagFilter(tag)}
        <X size={12} aria-hidden />
      </TagChip>
    </FilterBar>
  )
}

const FilterBar = styled.div`
  display: flex;
  margin-bottom: ${({ theme }) => theme.space(3)};
`

const PagerBar = styled.nav`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: ${({ theme }) => theme.space(4)};
`

export const BackLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: ${({ theme }) => theme.space(3)};
  color: ${({ theme }) => theme.colors.primary};
  font-size: 14px;
`

const WriteLink = styled(Link)`
  color: ${({ theme }) => theme.colors.primary};
  font-weight: 600;
`

const Links = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(4)};
`

const Meta = styled.p`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0 0 ${({ theme }) => theme.space(4)};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

const CommentList = styled.ol`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const CommentBox = styled.li<{ $reply: boolean }>`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin-left: ${({ $reply }) => ($reply ? '28px' : '0')};
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme, $reply }) => ($reply ? theme.colors.surfaceAlt : theme.colors.surface)};
`

const CommentHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Actions = styled.div`
  display: flex;
  gap: 4px;
`

const Composer = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin-top: ${({ theme }) => theme.space(4)};

  & > div {
    display: flex;
    justify-content: flex-end;
    gap: ${({ theme }) => theme.space(2)};
  }
`

const PostReactions = styled.div`
  margin-top: ${({ theme }) => theme.space(3)};
`

const ReactionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`

const ReactionButton = styled.button<{ $mine: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 10px;
  border: 1px solid ${({ theme, $mine }) => ($mine ? theme.colors.primary : theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $mine }) => ($mine ? theme.colors.accentSoft : theme.colors.surface)};
  color: ${({ theme, $mine }) => ($mine ? theme.colors.accentStrong : theme.colors.textMuted)};
  font-size: 13px;
  cursor: pointer;

  &:hover:not(:disabled) {
    border-color: ${({ theme }) => theme.colors.primary};
  }
  &:disabled {
    cursor: default;
  }
`

/**
 * 按讚 (AC-13.1): the five reactions under a post or a comment. A member has one on each: another
 * replaces it, the same one again takes it back. The server answers with the reactions as they are now
 */
function ReactionBar({
  target,
  targetId,
  reactions,
  onError,
}: {
  target: 'post' | 'comment'
  targetId: string
  reactions: Reactions
  onError: (error: unknown) => void
}) {
  const { t } = usePreferences()
  const { user } = useAuth()
  const name = useMemberName()
  // What the server last answered, until the page loads the post again
  const [answer, setAnswer] = useState<{ of: Reactions; now: Reactions } | null>(null)
  const current = answer?.of === reactions ? answer.now : reactions
  const [busy, setBusy] = useState(false)

  const mine = REACTION_EMOJIS.find((emoji) => !!user && current[emoji]?.includes(user.id))
  const choose = async (emoji: ReactionEmoji) => {
    setBusy(true)
    try {
      const now = emoji === mine ? await forumApi.unreact(target, targetId) : await forumApi.react(target, targetId, emoji)
      setAnswer({ of: reactions, now })
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <ReactionRow role="group" aria-label={t.forum.reactions}>
      {REACTION_EMOJIS.map((emoji) => {
        const who = current[emoji] ?? []
        return (
          <ReactionButton
            key={emoji}
            type="button"
            $mine={emoji === mine}
            aria-pressed={emoji === mine}
            aria-label={t.forum.react(emoji, who.length)}
            title={who.map(name).join(', ') || undefined}
            disabled={busy}
            onClick={() => void choose(emoji)}
          >
            <span aria-hidden>{emoji}</span>
            {who.length > 0 && <span aria-hidden>{who.length}</span>}
          </ReactionButton>
        )
      })}
    </ReactionRow>
  )
}

/** A comment's text: its paragraphs, which are what the edit form changes */
const commentText = (blocks: CommentBlock[]) =>
  blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.text] : [])).join('\n\n')

/** The blocks with `text` as their one paragraph, where the first one was; its auction or hand stays as it is */
function withCommentText(blocks: CommentBlock[], text: string): CommentBlock[] {
  const others = blocks.filter((block) => block.kind !== 'paragraph')
  const trimmed = text.trim()
  if (!trimmed) return others
  // Everything before the first paragraph is not a paragraph, so its place among the others is the same
  const at = Math.max(0, blocks.findIndex((block) => block.kind === 'paragraph'))
  return [...others.slice(0, at), { kind: 'paragraph', text: trimmed }, ...others.slice(at)]
}

/** Its author edits a comment's text in place (AC-13.1) */
function CommentEditForm({ comment, onSave, onCancel }: { comment: Comment; onSave: (blocks: CommentBlock[]) => Promise<void>; onCancel: () => void }) {
  const { t } = usePreferences()
  const [text, setText] = useState(() => commentText(comment.blocks))
  const [busy, setBusy] = useState(false)
  const blocks = withCommentText(comment.blocks, text)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!blocks.length || busy) return
    setBusy(true)
    try {
      await onSave(blocks)
    } catch {
      // The page shows the error; the form stays open with the text
    } finally {
      setBusy(false)
    }
  }
  return (
    <Composer onSubmit={submit}>
      <Textarea aria-label={t.forum.editCommentLabel} rows={3} maxLength={FORUM_LIMITS.commentTextMax} value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <Button type="button" $variant="ghost" onClick={onCancel}>
          {t.forum.cancel}
        </Button>
        <Button type="submit" disabled={!blocks.length} $busy={busy}>
          {t.forum.saveComment}
        </Button>
      </div>
    </Composer>
  )
}

/** The page in `?page=`, from 1, and the tag in `?tag=` (AC-13.7), kept when the page changes */
function usePage(): [number, (page: number) => void, string] {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const tag = (params.get('tag') ?? '').trim()
  const setPage = (n: number) => setParams({ ...(tag ? { tag } : {}), ...(n > 1 ? { page: String(n) } : {}) })
  return [page, setPage, tag]
}

export function ForumPager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
  const { t } = usePreferences()
  if (pages <= 1) return null
  return (
    <PagerBar aria-label={t.forum.pages}>
      <Button type="button" $variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t.prevPage} title={t.prevPage}>
        <ChevronLeft size={16} aria-hidden />
      </Button>
      <Muted aria-current="page">{t.forum.pageOf(page, pages)}</Muted>
      <Button type="button" $variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t.nextPage} title={t.nextPage}>
        <ChevronRight size={16} aria-hidden />
      </Button>
    </PagerBar>
  )
}

export function PostRows({ posts, boards }: { posts: Post[]; boards?: Board[] }) {
  const { t, lang } = usePreferences()
  const name = useMemberName()
  return (
    <PostList>
      {posts.map((post) => {
        const board = boards?.find((b) => b.id === post.boardId)
        return (
          <li key={post.id}>
            <Row to={`/forum/p/${encodeURIComponent(post.id)}`}>
              <strong>
                {post.pinned && (
                  <Badge>
                    <Pin size={12} aria-hidden />
                    {t.forum.pinned}
                  </Badge>
                )}
                {post.locked && (
                  <Badge>
                    <Lock size={12} aria-hidden />
                    {t.forum.locked}
                  </Badge>
                )}
                {post.hidden && (
                  <Badge>
                    <EyeOff size={12} aria-hidden />
                    {t.forum.hidden}
                  </Badge>
                )}
                <ReleaseBadge post={post} />
                {post.title || t.forum.untitled}
              </strong>
              <small>
                {board ? `${board.name} · ` : ''}
                {notOut(post)
                  ? `${name(post.authorId)} · ${
                      post.publishAt !== undefined
                        ? t.forumNews.scheduledFor(formatDateTime(post.publishAt, lang))
                        : t.forumNews.savedAt(formatDateTime(post.createdAt, lang))
                    }`
                  : t.forum.byLine(name(post.authorId), formatDateTime(post.createdAt, lang))}
              </small>
              {!!post.tags?.length && (
                <TagRow aria-label={t.forum.tags}>
                  {post.tags.map((tag) => (
                    <li key={tag}>
                      <TagText>#{tag}</TagText>
                    </li>
                  ))}
                </TagRow>
              )}
              <Count aria-label={t.forum.commentCount(post.commentCount)}>
                <MessageSquare size={14} aria-hidden />
                {post.commentCount}
              </Count>
            </Row>
          </li>
        )
      })}
    </PostList>
  )
}

/** 草稿／排程中 (e13-t12): a post that is not out yet says so */
function ReleaseBadge({ post }: { post: Post }) {
  const { t } = usePreferences()
  if (post.publishAt !== undefined)
    return (
      <Badge>
        <CalendarClock size={12} aria-hidden />
        {t.forumNews.scheduled}
      </Badge>
    )
  if (post.draft)
    return (
      <Badge>
        <FilePen size={12} aria-hidden />
        {t.forumNews.draft}
      </Badge>
    )
  return null
}

/** 發文: the table's editor, on this board when there is one */
function Write({ board }: { board?: Board }) {
  const { t } = usePreferences()
  const officer = useOfficer()
  if (board && board.postPolicy === 'officers' && !officer) return null
  return <WriteLink to={board ? `/forum/new?board=${encodeURIComponent(board.id)}` : '/forum/new'}>{t.forum.write}</WriteLink>
}

/** `/forum`: the boards and every board's latest posts */
export function ForumHomePage() {
  const { t, message } = usePreferences()
  const [page, setPage, tag] = usePage()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [feed, setFeed] = useState<ForumFeed | null>(null)
  const [tags, setTags] = useState<ForumTags['tags']>([])
  const [error, setError] = useState('')

  useEffect(() => {
    forumApi
      .boards()
      .then(setBoards)
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [message])
  useEffect(() => {
    forumApi
      .tags()
      .then(setTags)
      .catch(() => setTags([]))
  }, [])
  useEffect(() => {
    forumApi
      .feed(page, undefined, tag || undefined)
      .then(setFeed)
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [page, tag, message])
  const officer = useOfficer()

  return (
    <PageMain>
      <PageTitle>{t.forum.title}</PageTitle>
      <Intro>
        <Muted>{t.forum.intro}</Muted>
        {/* Search and the officers' reports (K4: e13-t11, e13-t10) */}
        <Links>
          <WriteLink to="/forum/search">{t.forum.search}</WriteLink>
          {officer && <WriteLink to="/forum/reports">{t.forum.reports}</WriteLink>}
          <WriteLink to="/forum/drafts">{t.forumNews.drafts}</WriteLink>
          <Write />
        </Links>
      </Intro>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <SectionTitle>{t.forum.boards}</SectionTitle>
      {!boards && !error && <Muted>{t.loading}</Muted>}
      {boards && (
        <BoardGrid>
          {boards.map((board) => (
            <li key={board.id}>
              <Tile to={`/forum/${encodeURIComponent(board.id)}`}>
                <strong>{board.name}</strong>
                <small>{board.description}</small>
                {board.postPolicy === 'officers' && <small>{t.forum.officersOnly}</small>}
              </Tile>
            </li>
          ))}
        </BoardGrid>
      )}
      {tags.length > 0 && (
        <>
          <SectionTitle>{t.forum.tags}</SectionTitle>
          <TagRow>
            {tags.map(({ tag: name, count }) => (
              <li key={name}>
                <TagChip to={name === tag ? '/forum' : tagHref(name)} $active={name === tag} aria-label={t.forum.tagLink(name)}>
                  <Hash size={11} aria-hidden />
                  {name} · {count}
                </TagChip>
              </li>
            ))}
          </TagRow>
        </>
      )}
      <SectionTitle>{t.forum.latest}</SectionTitle>
      {tag && <TagFilter tag={tag} clear="/forum" />}
      {!feed && !error && <Muted>{t.loading}</Muted>}
      {feed && feed.posts.length === 0 && <Muted>{t.forum.noPosts}</Muted>}
      {feed && feed.posts.length > 0 && <PostRows posts={feed.posts} boards={boards ?? undefined} />}
      {feed && <ForumPager page={feed.page} pages={feed.pages} onPage={setPage} />}
    </PageMain>
  )
}

/** `/forum/:boardId`: one board, pinned posts first */
export function ForumBoardPage() {
  const { boardId = '' } = useParams()
  const { t, message } = usePreferences()
  const [page, setPage, tag] = usePage()
  const [data, setData] = useState<BoardPage | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    forumApi
      .boardPage(boardId, page, tag || undefined)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [boardId, page, tag, message])

  const posts = data ? [...data.pinned, ...data.posts] : []
  return (
    <PageMain>
      <BackLink to="/forum">
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{data?.board.name ?? t.forum.title}</PageTitle>
      {data && (
        <Intro>
          <Muted>
            {data.board.description}
            {data.board.postPolicy === 'officers' ? ` · ${t.forum.officersOnly}` : ''}
          </Muted>
          <Write board={data.board} />
        </Intro>
      )}
      {tag && <TagFilter tag={tag} clear={`/forum/${encodeURIComponent(boardId)}`} />}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!data && !error && <Muted>{t.loading}</Muted>}
      {data && posts.length === 0 && <Muted>{t.forum.noPosts}</Muted>}
      {posts.length > 0 && <PostRows posts={posts} />}
      {data && <ForumPager page={data.page} pages={data.pages} onPage={setPage} />}
    </PageMain>
  )
}

function CommentForm({
  label,
  onSend,
  onCancel,
  auctionOpen,
  onAuction,
}: {
  label: string
  onSend: (blocks: CommentBlock[]) => Promise<void>
  onCancel?: () => void
  /** Whether this form's auction editor is the open one (one bidding box on the page at a time) */
  auctionOpen: boolean
  onAuction: (open: boolean) => void
}) {
  const { t } = usePreferences()
  const [text, setText] = useState('')
  const [auction, setAuction] = useState<ForumAuction>(() => emptyAuction())
  const [busy, setBusy] = useState(false)
  const blocks: CommentBlock[] = [
    ...(text.trim() ? [{ kind: 'paragraph' as const, text: text.trim() }] : []),
    ...(auctionOpen && auction.calls.length ? [{ kind: 'auction' as const, auction }] : []),
  ]
  const toggleAuction = () => {
    setAuction(emptyAuction())
    onAuction(!auctionOpen)
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!blocks.length || busy) return
    setBusy(true)
    try {
      await onSend(blocks)
      setText('')
      setAuction(emptyAuction())
      onAuction(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Composer onSubmit={submit}>
      <Textarea
        aria-label={label}
        placeholder={label}
        rows={3}
        maxLength={FORUM_LIMITS.commentTextMax}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {auctionOpen && <AuctionEditor value={auction} onChange={setAuction} />}
      <div>
        <Button type="button" $variant="ghost" onClick={toggleAuction}>
          {auctionOpen ? t.forum.removeAuction : t.forum.addAuction}
        </Button>
        {onCancel && (
          <Button type="button" $variant="ghost" onClick={onCancel}>
            {t.forum.cancel}
          </Button>
        )}
        <Button type="submit" disabled={!blocks.length} $busy={busy}>
          {t.forum.send}
        </Button>
      </div>
    </Composer>
  )
}

/** `/forum/p/:postId`: the post and its comments */
export function ForumPostPage() {
  const { postId = '' } = useParams()
  const { t, lang, message } = usePreferences()
  const { user } = useAuth()
  const name = useMemberName()
  const navigate = useNavigate()
  const [thread, setThread] = useState<PostThread | null>(null)
  const [error, setError] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  // Which comment form has its auction editor open: the top one ('') or a reply's
  const [auctionIn, setAuctionIn] = useState<string | null>(null)
  // Which post or comment the report form is open on (K4, e13-t10), and the thanks once one is sent
  const [reporting, setReporting] = useState<string | null>(null)
  const [reported, setReported] = useState(false)
  // The comment being edited (AC-13.1)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(
    () =>
      forumApi
        .post(postId)
        .then((d) => {
          setThread(d)
          setError('')
        })
        .catch((e) => setError(message(e.code, e.params, e.message))),
    [postId, message],
  )
  useEffect(() => {
    void load()
  }, [load])

  // A notification about a comment opens the post at it (`#comment-<id>`, e13-t09), once it is drawn
  const { hash } = useLocation()
  const loadedId = thread?.post.id
  useEffect(() => {
    if (!loadedId || !hash.startsWith('#comment-')) return
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView?.({ block: 'center' })
  }, [loadedId, hash])

  const officer = useOfficer()
  const post = thread?.post
  // A draft or a scheduled post (e13-t12) takes no comments, reports or hiding until it is out
  const unpublished = !!post && notOut(post)
  const mayComment = !!post && !unpublished && (!post.locked || officer)

  const send = (parentId?: string) => async (blocks: CommentBlock[]) => {
    try {
      setError('')
      await forumApi.comment(postId, { parentId, blocks })
      setReplyTo(null)
      await load()
    } catch (e) {
      const err = e as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(err.code ?? '', err.params ?? {}, err.message))
      throw e
    }
  }
  const remove = async (comment: Comment) => {
    if (!window.confirm(t.forum.confirmDeleteComment)) return
    try {
      await forumApi.deleteComment(comment.id)
      await load()
    } catch (e) {
      const err = e as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(err.code ?? '', err.params ?? {}, err.message))
    }
  }

  const removePost = async () => {
    if (!post || !window.confirm(t.forum.confirmDeletePost)) return
    try {
      await forumApi.deletePost(post.id)
      navigate(`/forum/${encodeURIComponent(post.boardId)}`)
    } catch (e) {
      const err = e as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(err.code ?? '', err.params ?? {}, err.message))
    }
  }
  /** An officer hides the post from everyone but its author and the officers, or shows it again */
  const toggleHidden = async () => {
    if (!post || (!post.hidden && !window.confirm(t.forum.confirmHide))) return
    try {
      setError('')
      await forumApi.hide(post.id, !post.hidden)
      await load()
    } catch (e) {
      const err = e as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(err.code ?? '', err.params ?? {}, err.message))
    }
  }
  /** What the server said, on the page */
  const showError = (e: unknown) => {
    const err = e as { code?: string; params?: Record<string, string | number>; message: string }
    setError(message(err.code ?? '', err.params ?? {}, err.message))
  }
  /** An officer pins the post above the board's others, or takes it down; the server checks */
  const togglePinned = async () => {
    if (!post) return
    try {
      setError('')
      await forumApi.pin(post.id, !post.pinned)
      await load()
    } catch (e) {
      showError(e)
    }
  }
  const saveComment = (commentId: string) => async (blocks: CommentBlock[]) => {
    try {
      setError('')
      await forumApi.updateComment(commentId, blocks)
      setEditing(null)
      await load()
    } catch (e) {
      showError(e)
      throw e
    }
  }
  const reportButton = (key: string, authorId: string) =>
    user && authorId !== user.id ? (
      <Button
        type="button"
        $variant="ghost"
        $size="sm"
        onClick={() => {
          setReported(false)
          setReporting(reporting === key ? null : key)
        }}
      >
        {t.forum.report}
      </Button>
    ) : null
  const reportForm = (key: string, target: 'post' | 'comment', targetId: string) =>
    reporting === key ? (
      <ReportForm
        target={target}
        targetId={targetId}
        onDone={(sent) => {
          setReporting(null)
          setReported(sent)
        }}
      />
    ) : null
  const auctionForm = (key: string) => ({
    auctionOpen: auctionIn === key,
    onAuction: (open: boolean) => setAuctionIn(open ? key : null),
  })

  const comments = thread?.comments ?? []
  return (
    <PageMain>
      <BackLink to={post ? `/forum/${encodeURIComponent(post.boardId)}` : '/forum'}>
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!thread && !error && <Muted>{t.loading}</Muted>}
      {post && (
        <>
          <PageTitle>{post.title || t.forum.untitled}</PageTitle>
          <Meta>
            {post.pinned && <Badge>{t.forum.pinned}</Badge>}
            {post.locked && <Badge>{t.forum.locked}</Badge>}
            {post.hidden && <Badge>{t.forum.hidden}</Badge>}
            <ReleaseBadge post={post} />
            <span>
              {t.forum.byLine(name(post.authorId), formatDateTime(post.createdAt, lang))}
              {post.editedAt ? ` · ${t.forum.edited}` : ''}
            </span>
            {post.authorId === user?.id && <WriteLink to={`/forum/p/${encodeURIComponent(post.id)}/edit`}>{t.forum.editPost}</WriteLink>}
            {(post.authorId === user?.id || officer) && (
              <Button type="button" $variant="ghost" $size="sm" onClick={() => void removePost()}>
                {t.forum.deletePost}
              </Button>
            )}
            {officer && !unpublished && (
              <Button type="button" $variant="ghost" $size="sm" onClick={() => void togglePinned()}>
                {post.pinned ? t.forum.unpin : t.forum.pin}
              </Button>
            )}
            {officer && !unpublished && (
              <Button type="button" $variant="ghost" $size="sm" onClick={() => void toggleHidden()}>
                {post.hidden ? t.forum.unhide : t.forum.hide}
              </Button>
            )}
            {!unpublished && reportButton(':post', post.authorId)}
          </Meta>
          <PostTags tags={post.tags} />
          {post.hidden && <Muted>{t.forum.hiddenHint}</Muted>}
          {post.publishAt !== undefined && <Muted role="note">{t.forumNews.scheduledHint(formatDateTime(post.publishAt, lang))}</Muted>}
          {post.draft && <Muted role="note">{t.forumNews.draftHint}</Muted>}
          {reportForm(':post', 'post', post.id)}
          {reported && <Muted role="status">{t.forum.reportSent}</Muted>}
          <Card>
            <ForumBlocks blocks={post.blocks} />
          </Card>
          {!unpublished && (
            <>
              <PostReactions>
                <ReactionBar target="post" targetId={post.id} reactions={post.reactions} onError={showError} />
              </PostReactions>
              <SectionTitle>
                {t.forum.comments} ({comments.length})
              </SectionTitle>
              {comments.length === 0 && <Muted>{t.forum.noComments}</Muted>}
              {comments.length > 0 && (
                <CommentList>
                  {comments.map((comment) => (
                    <CommentBox key={comment.id} id={`comment-${comment.id}`} $reply={!!comment.parentId}>
                      <CommentHead>
                        <span>
                          {t.forum.byLine(name(comment.authorId), formatDateTime(comment.createdAt, lang))}
                          {comment.editedAt ? ` · ${t.forum.edited}` : ''}
                        </span>
                        <Actions>
                          {mayComment && (
                            <Button type="button" $variant="ghost" $size="sm" onClick={() => setReplyTo(comment.parentId ?? comment.id)}>
                              {t.forum.reply}
                            </Button>
                          )}
                          {comment.authorId === user?.id && (
                            <Button type="button" $variant="ghost" $size="sm" onClick={() => setEditing(editing === comment.id ? null : comment.id)}>
                              {t.forum.editComment}
                            </Button>
                          )}
                          {(comment.authorId === user?.id || officer) && (
                            <Button type="button" $variant="ghost" $size="sm" onClick={() => void remove(comment)}>
                              {t.forum.deleteComment}
                            </Button>
                          )}
                          {reportButton(comment.id, comment.authorId)}
                        </Actions>
                      </CommentHead>
                      {reportForm(comment.id, 'comment', comment.id)}
                      {editing === comment.id ? (
                        <CommentEditForm comment={comment} onSave={saveComment(comment.id)} onCancel={() => setEditing(null)} />
                      ) : (
                        <ForumBlocks blocks={comment.blocks} />
                      )}
                      <ReactionBar target="comment" targetId={comment.id} reactions={comment.reactions} onError={showError} />
                      {replyTo === comment.id && (
                        <CommentForm
                          label={t.forum.replyLabel(name(comment.authorId))}
                          onSend={send(comment.id)}
                          onCancel={() => setReplyTo(null)}
                          {...auctionForm(comment.id)}
                        />
                      )}
                    </CommentBox>
                  ))}
                </CommentList>
              )}
              {mayComment ? <CommentForm label={t.forum.commentLabel} onSend={send()} {...auctionForm('')} /> : <Muted>{t.forum.lockedHint}</Muted>}
            </>
          )}
        </>
      )}
    </PageMain>
  )
}

/** `/forum/drafts` (e13-t12): my drafts and scheduled posts; an officer sees everyone's scheduled ones too */
export function ForumDraftsPage() {
  const { t, message } = usePreferences()
  const [posts, setPosts] = useState<Post[] | null>(null)
  const [boards, setBoards] = useState<Board[] | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    forumApi
      .drafts()
      .then(setPosts)
      .catch((e) => setError(message(e.code, e.params, e.message)))
    forumApi
      .boards()
      .then(setBoards)
      .catch(() => setBoards(undefined))
  }, [message])

  return (
    <PageMain>
      <BackLink to="/forum">
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{t.forumNews.drafts}</PageTitle>
      <Intro>
        <Muted>{t.forumNews.draftsIntro}</Muted>
        <Write />
      </Intro>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!posts && !error && <Muted>{t.loading}</Muted>}
      {posts && posts.length === 0 && <Muted>{t.forumNews.noDrafts}</Muted>}
      {posts && posts.length > 0 && <PostRows posts={posts} boards={boards} />}
    </PageMain>
  )
}
