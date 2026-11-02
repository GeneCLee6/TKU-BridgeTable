import { ChevronLeft } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import { FORUM_LIMITS, type Board, type ForumSearch, type ReportItem } from '../../shared/forum.ts'
import { Segmented, SegmentButton } from '../components/Chips.tsx'
import { Button, ErrorText, FieldHint, Input, Muted, PageMain, PageTitle, Select, Textarea } from '../components/ui.tsx'
import { formatDateTime } from '../lib/format.ts'
import { forumApi } from '../lib/forum.ts'
import { useMemberName, useOfficer } from '../lib/forumHooks.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { BackLink, Badge, ForumPager, Intro, PostRows } from './ForumPages.tsx'

/**
 * 論壇的檢舉、隱藏與搜尋 (E13 K4: `e13-t10`, `e13-t11`, ARCHITECTURE.md §5.19). The API was
 * BridgeHall's (e11-t09, e11-t10); hiding a post and searching one board are the table's additions.
 *
 * - `ReportForm`: a member reports someone else's post or comment (on the post page)
 * - `/forum/search?q=&board=&page=`: titles and text holding every word, on one board or all
 * - `/forum/reports`: the officers' list of reports; dismiss, delete what was reported, or hide the post
 *
 * Who may do what is the server's (roles.ts, worker/forum.ts); the buttons only follow the same rules.
 */

type ApiFailure = { code?: string; params?: Record<string, string | number>; message: string }

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin: ${({ theme }) => theme.space(2)} 0 ${({ theme }) => theme.space(3)};

  & > div {
    display: flex;
    justify-content: flex-end;
    gap: ${({ theme }) => theme.space(2)};
  }
`

/** A member reports a post or a comment to the officers; `onDone(true)` once it is sent */
export function ReportForm({
  target,
  targetId,
  onDone,
}: {
  target: 'post' | 'comment'
  targetId: string
  onDone: (sent: boolean) => void
}) {
  const { t, message } = usePreferences()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!reason.trim() || busy) return
    setBusy(true)
    try {
      await forumApi.report({ target, targetId, reason: reason.trim() })
      onDone(true)
    } catch (err) {
      const { code, params, message: text } = err as ApiFailure
      setError(message(code ?? '', params ?? {}, text))
      setBusy(false)
    }
  }
  return (
    <Form onSubmit={submit}>
      <Textarea
        aria-label={t.forum.reportLabel}
        placeholder={t.forum.reportLabel}
        rows={2}
        maxLength={FORUM_LIMITS.reportReasonMax}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <FieldHint>{t.forum.reportHint}</FieldHint>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <div>
        <Button type="button" $variant="ghost" onClick={() => onDone(false)}>
          {t.forum.cancel}
        </Button>
        <Button type="submit" $variant="danger" disabled={!reason.trim()} $busy={busy}>
          {t.forum.reportSend}
        </Button>
      </div>
    </Form>
  )
}

const SearchForm = styled.form`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: ${({ theme }) => theme.space(2)};
  margin-bottom: ${({ theme }) => theme.space(2)};

  @media (max-width: 560px) {
    grid-template-columns: minmax(0, 1fr) auto;
    & > input {
      grid-column: 1 / -1;
    }
  }
`

/** `/forum/search`: the forum's posts holding every word of `?q=`, on `?board=` or every board */
export function ForumSearchPage() {
  const { t, message } = usePreferences()
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') ?? '').trim()
  const board = params.get('board') ?? ''
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const [text, setText] = useState(query)
  const [boardChoice, setBoardChoice] = useState(board)
  const [boards, setBoards] = useState<Board[] | null>(null)
  // The answer and the search it answers: a new search shows nothing until its own answer comes
  const [answer, setAnswer] = useState<{ key: string; found: ForumSearch } | null>(null)
  const [error, setError] = useState('')
  const key = JSON.stringify([query, board, page])
  const found = query && answer?.key === key ? answer.found : null

  useEffect(() => {
    forumApi
      .boards()
      .then(setBoards)
      .catch(() => setBoards([]))
  }, [])
  useEffect(() => {
    if (!query) return
    const asked = JSON.stringify([query, board, page])
    forumApi
      .search(query, page, board || undefined)
      .then((r) => {
        setAnswer({ key: asked, found: r })
        setError('')
      })
      .catch((e: ApiFailure) => setError(message(e.code ?? '', e.params ?? {}, e.message)))
  }, [query, board, page, message])

  const go = (next: { q: string; board: string; page?: number }) =>
    setParams({
      q: next.q,
      ...(next.board ? { board: next.board } : {}),
      ...(next.page && next.page > 1 ? { page: String(next.page) } : {}),
    })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim()) go({ q: text.trim(), board: boardChoice })
  }

  return (
    <PageMain>
      <BackLink to="/forum">
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{t.forum.searchTitle}</PageTitle>
      <SearchForm role="search" onSubmit={submit}>
        <Input
          type="search"
          aria-label={t.forum.searchLabel}
          placeholder={t.forum.searchLabel}
          maxLength={FORUM_LIMITS.searchMax}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Select aria-label={t.forum.boardFilter} value={boardChoice} onChange={(e) => setBoardChoice(e.target.value)}>
          <option value="">{t.forum.allBoards}</option>
          {(boards ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={!text.trim()}>
          {t.forum.search}
        </Button>
      </SearchForm>
      <FieldHint>{t.forum.searchHint(FORUM_LIMITS.searchMax, FORUM_LIMITS.searchWordsMax)}</FieldHint>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {query && !found && !error && <Muted>{t.loading}</Muted>}
      {found && (
        <>
          <Muted role="status">{found.total ? t.forum.searchResults(found.total, found.query) : t.forum.noResults}</Muted>
          {found.posts.length > 0 && <PostRows posts={found.posts} boards={boards ?? undefined} />}
          <ForumPager page={found.page} pages={found.pages} onPage={(n) => go({ q: query, board, page: n })} />
        </>
      )}
    </PageMain>
  )
}

const ReportList = styled.ul`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: ${({ theme }) => theme.space(4)} 0 0;
  padding: 0;
  list-style: none;
`

const ReportCard = styled.li`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(3)} ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};

  & > p {
    margin: 0;
    overflow-wrap: anywhere;
  }
`

const ReportHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Small = styled.small`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const ReportActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};

  & > a {
    color: ${({ theme }) => theme.colors.primary};
    font-size: 14px;
    font-weight: 600;
  }
`

/** `/forum/reports`: the officers' reports, open ones or all, newest first */
export function ForumReportsPage() {
  const { t, lang, message } = usePreferences()
  const officer = useOfficer()
  const name = useMemberName()
  const [status, setStatus] = useState<'open' | 'all'>('open')
  const [items, setItems] = useState<ReportItem[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(
    () =>
      forumApi
        .reports(status)
        .then((r) => {
          setItems(r)
          setError('')
        })
        .catch((e: ApiFailure) => setError(message(e.code ?? '', e.params ?? {}, e.message))),
    [status, message],
  )
  useEffect(() => {
    if (officer) void load()
  }, [officer, load])

  if (!officer) return <Navigate to="/forum" replace />

  const act = async (item: ReportItem, action: 'dismiss' | 'remove' | 'hide') => {
    if (action === 'remove' && !window.confirm(t.forum.confirmRemoveReported)) return
    if (action === 'hide' && !window.confirm(t.forum.confirmHide)) return
    setBusy(item.report.id)
    try {
      if (action === 'hide' && item.postId) await forumApi.hide(item.postId, true)
      else await forumApi.decide(item.report.id, action === 'remove' ? 'remove' : 'dismiss')
    } catch (e) {
      const { code, params, message: text } = e as ApiFailure
      setError(message(code ?? '', params ?? {}, text))
    }
    setBusy(null)
    await load()
  }

  return (
    <PageMain>
      <BackLink to="/forum">
        <ChevronLeft size={16} aria-hidden />
        {t.forum.back}
      </BackLink>
      <PageTitle>{t.forum.reportsTitle}</PageTitle>
      <Intro>
        <Segmented role="group" aria-label={t.forum.reportsTitle}>
          {(['open', 'all'] as const).map((s) => (
            <SegmentButton key={s} type="button" $active={status === s} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {s === 'open' ? t.forum.reportsOpen : t.forum.reportsAll}
            </SegmentButton>
          ))}
        </Segmented>
      </Intro>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!items && !error && <Muted>{t.loading}</Muted>}
      {items && items.length === 0 && <Muted>{t.forum.noReports}</Muted>}
      {items && items.length > 0 && (
        <ReportList>
          {items.map((item) => {
            const { report } = item
            const open = report.status === 'open'
            const link = item.postId
              ? `/forum/p/${encodeURIComponent(item.postId)}${report.target === 'comment' ? `#comment-${encodeURIComponent(report.targetId)}` : ''}`
              : null
            return (
              <ReportCard key={report.id}>
                <ReportHead>
                  <Badge>{report.target === 'post' ? t.forum.reportPost : t.forum.reportComment}</Badge>
                  <Badge>{t.forum.reportStatus[report.status]}</Badge>
                  <span>{t.forum.reportBy(name(report.reporterId), formatDateTime(report.createdAt, lang))}</span>
                </ReportHead>
                <p>{report.reason}</p>
                {item.authorId ? (
                  <Small>
                    {t.forum.reportAuthor(name(item.authorId))} · {item.excerpt}
                  </Small>
                ) : (
                  <Small>{t.forum.reportGone}</Small>
                )}
                {report.handledBy && report.handledAt !== undefined && (
                  <Small>{t.forum.handledBy(name(report.handledBy), formatDateTime(report.handledAt, lang))}</Small>
                )}
                {(link || open) && (
                  <ReportActions>
                    {link && <Link to={link}>{t.forum.viewPost}</Link>}
                    {open && (
                      <>
                        <Button type="button" $variant="ghost" $size="sm" disabled={busy !== null} onClick={() => void act(item, 'dismiss')}>
                          {t.forum.dismiss}
                        </Button>
                        {report.target === 'post' && item.postId && (
                          <Button type="button" $variant="secondary" $size="sm" disabled={busy !== null} onClick={() => void act(item, 'hide')}>
                            {t.forum.hide}
                          </Button>
                        )}
                        <Button type="button" $variant="danger" $size="sm" disabled={busy !== null} onClick={() => void act(item, 'remove')}>
                          {t.forum.removeReported}
                        </Button>
                      </>
                    )}
                  </ReportActions>
                )}
              </ReportCard>
            )
          })}
        </ReportList>
      )}
    </PageMain>
  )
}
