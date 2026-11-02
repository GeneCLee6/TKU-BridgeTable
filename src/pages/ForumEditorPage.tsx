import { ArrowDown, ArrowUp, ChevronLeft, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import { FORUM_LIMITS, type Board, type Post, type PostBlock } from '../../shared/forum.ts'
import {
  blocksOf,
  CAPTION_MAX,
  dealerFor,
  emptyAuction,
  emptyDeal,
  isPostDraft,
  piecesOf,
  postProblems,
  type EditorPiece,
  type PostDraft,
  type PostProblem,
} from '../../shared/forum-editor.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { AuctionEditor } from '../components/AuctionEditor.tsx'
import { DealEditor } from '../components/DealEditor.tsx'
import { ForumBlocks, ForumDeal } from '../components/ForumBlocks.tsx'
import { Button, Card, ErrorText, FieldHint, FieldLabel, Input, Muted, PageMain, PageTitle, Select, Textarea } from '../components/ui.tsx'
import { forumApi } from '../lib/forum.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import type { Strings } from '../strings.ts'

/**
 * 發文編輯器 (E13 K2, `e13-t04`, ARCHITECTURE.md §5.19): writing a post on the table's own site,
 * in the forum's blocks that BridgeHall shows as well. The post is a list of pieces: text in a
 * Markdown subset (`parseMarkdown`), four hands (`DealEditor`), an auction (`AuctionEditor`), and,
 * when editing a post written on BridgeHall, the blocks this editor does not edit (kept as they
 * were; moved or removed only). One deal or auction is open for editing at a time; the others show
 * as the post will. What the Worker would refuse is listed before sending (`postProblems`).
 *
 * - `/forum/new?board=`: a new post; its draft is kept on this device until it is published
 * - `/forum/p/:postId/edit`: the author edits a post (the board stays)
 */

const DRAFT_KEY = 'tku-bridgetable:forumDraft'

function loadDraft(): PostDraft | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(DRAFT_KEY) ?? 'null')
    return isPostDraft(value) ? value : null
  } catch {
    return null
  }
}

function saveDraft(draft: PostDraft | null) {
  try {
    if (draft && (draft.title.trim() || draft.blocks.length)) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    else window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    // A full or blocked storage only loses the draft
  }
}

interface Item {
  id: number
  piece: EditorPiece
}

let nextId = 1
const item = (piece: EditorPiece): Item => ({ id: nextId++, piece })

const problemText = (e: Strings['forumEditor'], t: Strings, p: PostProblem): string => {
  switch (p.kind) {
    case 'empty':
      return e.problemEmpty
    case 'tooManyBlocks':
      return e.problemTooManyBlocks(p.max)
    case 'tooLong':
      return e.problemTooLong(p.length, p.max)
    case 'titleTooLong':
      return e.problemTitleTooLong(p.max)
    case 'deal':
      if (p.problem.kind === 'duplicate') return e.problemDuplicate(p.problem.card)
      if (p.problem.kind === 'tooMany') return e.problemTooMany(t.seatNames[p.problem.seat])
      return e.problemDealEmpty
    case 'auction':
      if (p.problem.kind === 'illegal') return e.problemIllegal(p.problem.index + 1)
      if (p.problem.kind === 'tooLong') return e.problemAuctionTooLong
      return e.problemAuctionEmpty
  }
}

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
`

const Labelled = styled.label`
  display: grid;
  gap: 4px;
`

const Pieces = styled.ol`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const PieceBox = styled.li`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  min-width: 0;
`

const PieceHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  & > strong {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
  & > div {
    display: flex;
    gap: 2px;
  }
`

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)};
`

const Problems = styled.ul`
  margin: 0;
  padding-left: 1.2em;
  color: ${({ theme }) => theme.colors.danger};
  font-size: 14px;
`

const Footer = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(3)};

  & > div {
    display: flex;
    gap: ${({ theme }) => theme.space(2)};
  }
`

const BackLink = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: ${({ theme }) => theme.space(3)};
  color: ${({ theme }) => theme.colors.primary};
  font-size: 14px;
`

/** The vulnerability of the last deal above an auction, for its colours */
function vulAbove(items: Item[], index: number) {
  for (let i = index - 1; i >= 0; i--) {
    const piece = items[i].piece
    if (piece.kind === 'deal') return piece.deal.vul
  }
  return 'None' as const
}

export function PostEditor({
  boards,
  post,
  boardId: preferred,
  onDone,
  onCancel,
}: {
  boards: readonly Board[]
  /** Editing this post; a new one when absent */
  post?: Post
  boardId?: string
  onDone: (post: Post) => void
  onCancel: () => void
}) {
  const { t, message } = usePreferences()
  const e = t.forumEditor
  const { user } = useAuth()
  const officer = !!user && (user.admin || user.permissions.includes('forumModerate'))
  const choices = boards.filter((b) => b.postPolicy === 'all' || officer)
  const [draft] = useState(() => (post ? null : loadDraft()))
  const firstBoard = [post?.boardId, preferred, draft?.boardId].find((id) => id && choices.some((b) => b.id === id))
  const [boardId, setBoardId] = useState(firstBoard ?? choices.find((b) => b.postPolicy === 'all')?.id ?? choices[0]?.id ?? '')
  const [title, setTitle] = useState(post?.title ?? draft?.title ?? '')
  const [items, setItems] = useState<Item[]>(() => {
    const blocks = post?.blocks ?? draft?.blocks ?? []
    const pieces = piecesOf(blocks)
    return (pieces.length ? pieces : [{ kind: 'text', text: '' } as EditorPiece]).map(item)
  })
  const [open, setOpen] = useState<number | null>(null)
  const [tried, setTried] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const boardSelect = useId()
  const titleId = useId()
  const hintId = useId()
  const sent = useRef(false)

  const blocks: PostBlock[] = blocksOf(items.map((i) => i.piece))
  const problems = postProblems(title, blocks)

  // A new post's draft is kept as it is written
  useEffect(() => {
    if (!post && !sent.current) saveDraft({ boardId, title, blocks: blocksOf(items.map((i) => i.piece)) })
  }, [post, boardId, title, items])

  const update = (id: number, piece: EditorPiece) => setItems((list) => list.map((i) => (i.id === id ? { ...i, piece } : i)))
  const move = (index: number, by: number) =>
    setItems((list) => {
      const next = [...list]
      const [moved] = next.splice(index, 1)
      next.splice(index + by, 0, moved)
      return next
    })
  const remove = (id: number) => setItems((list) => list.filter((i) => i.id !== id))
  const add = (piece: EditorPiece) => {
    const added = item(piece)
    setItems((list) => [...list, added])
    if (piece.kind === 'deal' || piece.kind === 'auction') setOpen(added.id)
  }
  const dealer = dealerFor(items.map((i) => i.piece))

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    setTried(true)
    if (problems.length || busy || !boardId) return
    setBusy(true)
    setError('')
    try {
      const input = { title: title.trim() || undefined, blocks }
      const done = post ? await forumApi.updatePost(post.id, input) : await forumApi.createPost(boardId, input)
      if (!post) {
        sent.current = true
        saveDraft(null)
      }
      onDone(done)
    } catch (err) {
      const x = err as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(x.code ?? '', x.params ?? {}, x.message))
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    if (!post) saveDraft(null)
    sent.current = true
    onCancel()
  }

  const shown = tried ? problems : problems.filter((p) => p.kind !== 'empty')
  return (
    <Form onSubmit={submit} noValidate>
      <Labelled htmlFor={boardSelect}>
        <FieldLabel as="span">{e.board}</FieldLabel>
        <Select id={boardSelect} value={boardId} disabled={!!post} onChange={(ev) => setBoardId(ev.target.value)} required>
          {!boardId && <option value="">{e.chooseBoard}</option>}
          {(post ? boards.filter((b) => b.id === post.boardId) : choices).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      </Labelled>
      <Labelled htmlFor={titleId}>
        <FieldLabel as="span">{e.titleLabel}</FieldLabel>
        <Input id={titleId} value={title} maxLength={FORUM_LIMITS.titleMax} onChange={(ev) => setTitle(ev.target.value)} />
      </Labelled>
      <FieldHint id={hintId}>{e.textHint}</FieldHint>
      <Pieces>
        {items.map(({ id, piece }, index) => {
          const editing = open === id
          const label = piece.kind === 'text' ? e.text : piece.kind === 'deal' ? e.deal : piece.kind === 'auction' ? e.auction : ''
          return (
            <PieceBox key={id}>
              <PieceHead>
                <strong>{label}</strong>
                <div>
                  {(piece.kind === 'deal' || piece.kind === 'auction') && (
                    <Button type="button" $variant="ghost" $size="sm" onClick={() => setOpen(editing ? null : id)}>
                      {editing ? e.done : e.edit}
                    </Button>
                  )}
                  <Button type="button" $variant="ghost" $size="sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={e.moveUp} title={e.moveUp}>
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    $variant="ghost"
                    $size="sm"
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={e.moveDown}
                    title={e.moveDown}
                  >
                    <ArrowDown size={14} aria-hidden />
                  </Button>
                  <Button type="button" $variant="ghost" $size="sm" onClick={() => remove(id)} aria-label={e.remove} title={e.remove}>
                    <X size={14} aria-hidden />
                  </Button>
                </div>
              </PieceHead>
              {piece.kind === 'text' && (
                <Textarea
                  aria-label={e.text}
                  aria-describedby={hintId}
                  rows={6}
                  value={piece.text}
                  onChange={(ev) => update(id, { ...piece, text: ev.target.value })}
                />
              )}
              {piece.kind === 'deal' &&
                (editing ? (
                  <DealEditor value={piece.deal} onChange={(deal) => update(id, { ...piece, deal })} />
                ) : (
                  <ForumDeal deal={piece.deal} />
                ))}
              {piece.kind === 'auction' &&
                (editing ? (
                  <AuctionEditor value={piece.auction} vul={vulAbove(items, index)} onChange={(auction) => update(id, { ...piece, auction })} />
                ) : (
                  <AuctionBox auction={piece.auction.calls} dealer={piece.auction.dealer} vul={vulAbove(items, index)} size={40} />
                ))}
              {(piece.kind === 'deal' || piece.kind === 'auction') && (
                <Input
                  aria-label={`${label} · ${e.caption}`}
                  placeholder={e.caption}
                  $size="sm"
                  maxLength={CAPTION_MAX}
                  value={piece.caption}
                  onChange={(ev) => update(id, { ...piece, caption: ev.target.value })}
                />
              )}
              {piece.kind === 'kept' && (
                <>
                  <ForumBlocks blocks={[piece.block]} />
                  <Muted>{e.kept}</Muted>
                </>
              )}
            </PieceBox>
          )
        })}
      </Pieces>
      <Toolbar>
        <Button type="button" $variant="secondary" $size="sm" onClick={() => add({ kind: 'text', text: '' })}>
          {e.addText}
        </Button>
        <Button type="button" $variant="secondary" $size="sm" onClick={() => add({ kind: 'deal', deal: emptyDeal(dealer), caption: '' })}>
          {e.addDeal}
        </Button>
        <Button type="button" $variant="secondary" $size="sm" onClick={() => add({ kind: 'auction', auction: emptyAuction(dealer), caption: '' })}>
          {e.addAuction}
        </Button>
      </Toolbar>
      {shown.length > 0 && (
        <Problems role="alert">
          {shown.map((p, i) => (
            <li key={i}>{problemText(e, t, p)}</li>
          ))}
        </Problems>
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Footer>
        <Muted>{post ? '' : e.draftKept}</Muted>
        <div>
          <Button type="button" $variant="ghost" onClick={discard}>
            {e.cancel}
          </Button>
          <Button type="submit" $busy={busy} disabled={!boardId || (tried && problems.length > 0)}>
            {post ? e.save : e.publish}
          </Button>
        </div>
      </Footer>
    </Form>
  )
}

/** `/forum/new?board=`: a new post */
export function ForumNewPostPage() {
  const { t, message } = usePreferences()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [error, setError] = useState('')
  const board = params.get('board') ?? undefined

  useEffect(() => {
    forumApi
      .boards()
      .then(setBoards)
      .catch((err) => setError(message(err.code, err.params, err.message)))
  }, [message])

  return (
    <PageMain>
      <BackLink to={board ? `/forum/${encodeURIComponent(board)}` : '/forum'}>
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{t.forumEditor.newTitle}</PageTitle>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!boards && !error && <Muted>{t.loading}</Muted>}
      {boards && (
        <Card>
          <PostEditor
            boards={boards}
            boardId={board}
            onDone={(post) => navigate(`/forum/p/${encodeURIComponent(post.id)}`)}
            onCancel={() => navigate(board ? `/forum/${encodeURIComponent(board)}` : '/forum')}
          />
        </Card>
      )}
    </PageMain>
  )
}

/** `/forum/p/:postId/edit`: the author edits a post */
export function ForumEditPostPage() {
  const { postId = '' } = useParams()
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [post, setPost] = useState<Post | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([forumApi.boards(), forumApi.post(postId)])
      .then(([b, thread]) => {
        setBoards(b)
        setPost(thread.post)
      })
      .catch((err) => setError(message(err.code, err.params, err.message)))
  }, [postId, message])

  const back = `/forum/p/${encodeURIComponent(postId)}`
  const mine = !!post && post.authorId === user?.id
  return (
    <PageMain>
      <BackLink to={back}>
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{t.forumEditor.editTitle}</PageTitle>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!post && !error && <Muted>{t.loading}</Muted>}
      {post && !mine && <ErrorText role="alert">{message('notYours', {}, '')}</ErrorText>}
      {post && mine && boards && (
        <Card>
          <PostEditor boards={boards} post={post} onDone={() => navigate(back)} onCancel={() => navigate(back)} />
        </Card>
      )}
    </PageMain>
  )
}
