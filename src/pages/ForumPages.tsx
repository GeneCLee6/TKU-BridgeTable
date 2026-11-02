import { ChevronLeft, ChevronRight, Lock, MessageSquare, Pin } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import { BOOK_SITE } from '../../shared/book-site.ts'
import { FORUM_LIMITS, type Board, type BoardPage, type Comment, type ForumFeed, type Post, type PostThread } from '../../shared/forum.ts'
import { ForumBlocks } from '../components/ForumBlocks.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle, Textarea } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { forumApi } from '../lib/forum.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'
import { cardHover } from '../styles/controls.ts'

/**
 * 論壇 (E13 K1, `e13-t03`, ARCHITECTURE.md §5.19): the table's pages on the club forum that
 * BridgeHall's forum also shows (the same `/api/forum/*`, the same posts). Behind the `forum`
 * feature flag (App.tsx). Three pages, at the same addresses as BridgeHall's, so a link to a post
 * reads the same on both sites:
 *
 * - `/forum`: the boards, then every board's posts newest first, a page at a time
 * - `/forum/:boardId`: one board, its pinned posts first (page 1), then newest first
 * - `/forum/p/:postId`: the post and its comments (one level of replies); members comment and
 *   reply, and delete their own comments (officers anyone's; the server checks)
 *
 * Writing a post is BridgeHall's until the table's editor (K2); the page links there.
 */

const Intro = styled.div`
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

const Badge = styled.span`
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

const PagerBar = styled.nav`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: ${({ theme }) => theme.space(4)};
`

const BackLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: ${({ theme }) => theme.space(3)};
  color: ${({ theme }) => theme.colors.primary};
  font-size: 14px;
`

const ExternalLink = styled.a`
  color: ${({ theme }) => theme.colors.primary};
  font-weight: 600;
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

/** A member's name from the lobby's member list; a member who left shows as such */
function useMemberName() {
  const { t } = usePreferences()
  const { lobby } = useClub()
  return useCallback(
    (id: string) => {
      const member = lobby?.members.find((m) => m.id === id)
      return member ? playerName(t, member) : t.forum.unknownMember
    },
    [lobby, t],
  )
}

/** The page in `?page=`, from 1 */
function usePage(): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const setPage = (n: number) => setParams(n > 1 ? { page: String(n) } : {})
  return [page, setPage]
}

function ForumPager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }) {
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

function PostRows({ posts, boards }: { posts: Post[]; boards?: Board[] }) {
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
                {post.title || t.forum.untitled}
              </strong>
              <small>
                {board ? `${board.name} · ` : ''}
                {t.forum.byLine(name(post.authorId), formatDateTime(post.createdAt, lang))}
              </small>
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

function WriteInHall() {
  const { t } = usePreferences()
  return (
    <ExternalLink href={`${BOOK_SITE}/forum/new`} target="_blank" rel="noreferrer">
      {t.forum.writeInHall}
    </ExternalLink>
  )
}

/** `/forum`: the boards and every board's latest posts */
export function ForumHomePage() {
  const { t, message } = usePreferences()
  const [page, setPage] = usePage()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [feed, setFeed] = useState<ForumFeed | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    forumApi
      .boards()
      .then(setBoards)
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [message])
  useEffect(() => {
    forumApi
      .feed(page)
      .then(setFeed)
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [page, message])

  return (
    <PageMain>
      <PageTitle>{t.forum.title}</PageTitle>
      <Intro>
        <Muted>{t.forum.intro}</Muted>
        <WriteInHall />
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
      <SectionTitle>{t.forum.latest}</SectionTitle>
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
  const [page, setPage] = usePage()
  const [data, setData] = useState<BoardPage | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    forumApi
      .boardPage(boardId, page)
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [boardId, page, message])

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
          <WriteInHall />
        </Intro>
      )}
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
}: {
  label: string
  onSend: (text: string) => Promise<void>
  onCancel?: () => void
}) {
  const { t } = usePreferences()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      await onSend(text.trim())
      setText('')
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
      <div>
        {onCancel && (
          <Button type="button" $variant="ghost" onClick={onCancel}>
            {t.forum.cancel}
          </Button>
        )}
        <Button type="submit" disabled={!text.trim()} $busy={busy}>
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
  const [thread, setThread] = useState<PostThread | null>(null)
  const [error, setError] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)

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

  const officer = !!user?.permissions.includes('forumModerate')
  const post = thread?.post
  const mayComment = !!post && (!post.locked || officer)

  const send = (parentId?: string) => async (text: string) => {
    try {
      setError('')
      await forumApi.comment(postId, { parentId, blocks: [{ kind: 'paragraph', text }] })
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
            <span>
              {t.forum.byLine(name(post.authorId), formatDateTime(post.createdAt, lang))}
              {post.editedAt ? ` · ${t.forum.edited}` : ''}
            </span>
          </Meta>
          <Card>
            <ForumBlocks blocks={post.blocks} />
          </Card>
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
                      {(comment.authorId === user?.id || officer) && (
                        <Button type="button" $variant="ghost" $size="sm" onClick={() => void remove(comment)}>
                          {t.forum.deleteComment}
                        </Button>
                      )}
                    </Actions>
                  </CommentHead>
                  <ForumBlocks blocks={comment.blocks} />
                  {replyTo === comment.id && (
                    <CommentForm
                      label={t.forum.replyLabel(name(comment.authorId))}
                      onSend={send(comment.id)}
                      onCancel={() => setReplyTo(null)}
                    />
                  )}
                </CommentBox>
              ))}
            </CommentList>
          )}
          {mayComment ? <CommentForm label={t.forum.commentLabel} onSend={send()} /> : <Muted>{t.forum.lockedHint}</Muted>}
        </>
      )}
    </PageMain>
  )
}
