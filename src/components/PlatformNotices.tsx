import { useId, useState } from 'react'
import styled from 'styled-components'
import { NOTICE_LIMITS, noticeLive, type PlatformNoticeView } from '../../shared/notices.ts'
import type { PlatformView } from '../../shared/platform.ts'
import { api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { fromLocalInput, localInput } from '../lib/forumRelease.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { SupportFacts } from './AdminSupport.tsx'
import { Button, Card, CardHeader, CardTitle, Field, FieldHint, FieldLabel, Input, Muted, Textarea } from './ui.tsx'

/**
 * The back office's announcements (e12-t15: draft, publish, optional end, withdraw) and the support
 * reports clubs' admins forwarded (e12-t16). Every answer is the whole view again, as on the rest of
 * `PlatformPage`, which runs the actions and shows the toasts.
 */

export type PlatformRun = (key: string, action: () => Promise<PlatformView>, done: string) => Promise<boolean>

const Item = styled.article`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(3)} 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  & p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
`

const Badge = styled.span<{ $tone: 'good' | 'bad' | 'wait' }>`
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $tone }) =>
    $tone === 'good' ? theme.colors.successSoft : $tone === 'bad' ? theme.colors.dangerSoft : theme.colors.accentSoft};
`

function NoticeForm({
  notice,
  busy,
  run,
  onDone,
}: {
  notice?: PlatformNoticeView
  busy: string | null
  run: PlatformRun
  onDone: () => void
}) {
  const { t } = usePreferences()
  const n = t.notices
  const id = useId()
  const [text, setText] = useState(notice?.text ?? '')
  const [until, setUntil] = useState(notice?.expiresAt !== undefined ? localInput(notice.expiresAt) : '')
  const key = `notice-save-${notice?.id ?? 'new'}`
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        const input = { ...(notice && { id: notice.id }), text, expiresAt: fromLocalInput(until) ?? null }
        if (await run(key, () => api.platform.saveNotice(input), n.draftSaved)) onDone()
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-text`}>{n.text}</FieldLabel>
        <Textarea id={`${id}-text`} rows={3} maxLength={NOTICE_LIMITS.textMax} value={text} onChange={(e) => setText(e.target.value)} required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-until`}>{n.until}</FieldLabel>
        <Input id={`${id}-until`} type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
        <FieldHint>{n.untilHint}</FieldHint>
      </Field>
      <Row>
        <Button type="submit" $size="sm" $variant="primary" $busy={busy === key}>
          {notice ? n.save : n.saveDraft}
        </Button>
        {notice && (
          <Button type="button" $size="sm" onClick={onDone}>
            {t.platform.cancel}
          </Button>
        )}
      </Row>
    </form>
  )
}

function NoticeItem({ notice, busy, run }: { notice: PlatformNoticeView; busy: string | null; run: PlatformRun }) {
  const { t, lang } = usePreferences()
  const n = t.notices
  const [editing, setEditing] = useState(false)
  // As of when the page showed it: the next answer shows the rest
  const [now] = useState(() => Date.now())
  const expired = !noticeLive(notice, now)
  const label = notice.status === 'draft' ? n.draft : notice.status === 'withdrawn' ? n.withdrawn : expired ? n.expired : n.published
  const tone = notice.status === 'published' && !expired ? 'good' : notice.status === 'draft' ? 'wait' : 'bad'
  const act = (action: 'publish' | 'withdraw' | 'delete', done: string) =>
    void run(`notice-${action}-${notice.id}`, () => api.platform.noticeAction(notice.id, action), done)
  if (editing) return <Item><NoticeForm notice={notice} busy={busy} run={run} onDone={() => setEditing(false)} /></Item>
  return (
    <Item>
      <Row>
        <Badge $tone={tone}>{label}</Badge>
        {notice.publishedAt !== undefined && <Muted as="span">{n.publishedAt(formatDateTime(notice.publishedAt, lang))}</Muted>}
        {notice.expiresAt !== undefined && <Muted as="span">{n.endsAt(formatDateTime(notice.expiresAt, lang))}</Muted>}
      </Row>
      <p>{notice.text}</p>
      <Row>
        {notice.status === 'published' ? (
          <Button type="button" $size="sm" $busy={busy === `notice-withdraw-${notice.id}`} onClick={() => act('withdraw', n.withdrawnToast)}>
            {n.withdraw}
          </Button>
        ) : (
          <Button type="button" $size="sm" $variant="primary" $busy={busy === `notice-publish-${notice.id}`} onClick={() => act('publish', n.publishedToast)}>
            {n.publish}
          </Button>
        )}
        <Button type="button" $size="sm" onClick={() => setEditing(true)}>
          {n.edit}
        </Button>
        {notice.status !== 'published' && (
          <Button type="button" $size="sm" $variant="danger" $busy={busy === `notice-delete-${notice.id}`} onClick={() => act('delete', n.deletedToast)}>
            {n.delete}
          </Button>
        )}
      </Row>
    </Item>
  )
}

export function PlatformNotices({ view, busy, run }: { view: PlatformView; busy: string | null; run: PlatformRun }) {
  const { t } = usePreferences()
  const n = t.notices
  const id = useId()
  /** A new form after each draft saved, so its boxes start empty */
  const [form, setForm] = useState(0)
  return (
    <Card aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle id={`${id}-title`}>{n.platformTitle}</CardTitle>
        <Muted>{n.platformIntro}</Muted>
      </CardHeader>
      <NoticeForm key={form} busy={busy} run={run} onDone={() => setForm((v) => v + 1)} />
      {!view.notices.length ? <Muted>{n.noNotices}</Muted> : view.notices.map((notice) => <NoticeItem key={notice.id} notice={notice} busy={busy} run={run} />)}
    </Card>
  )
}

export function PlatformSupport({ view, busy, run }: { view: PlatformView; busy: string | null; run: PlatformRun }) {
  const { t, lang } = usePreferences()
  const s = t.support
  const id = useId()
  return (
    <Card aria-labelledby={`${id}-title`}>
      <CardHeader>
        <CardTitle id={`${id}-title`}>{s.platformTitle}</CardTitle>
        <Muted>{s.platformIntro}</Muted>
      </CardHeader>
      {!view.support.length && <Muted>{s.platformNone}</Muted>}
      {view.support.map((report) => {
        const key = `support-${report.clubId}-${report.id}`
        const open = report.status === 'open'
        return (
          <Item key={key} aria-label={s.fromClub(report.clubId)}>
            <Row>
              <code>{report.clubId}</code>
              <Muted as="span">{s.forwardedAt(formatDateTime(report.forwardedAt, lang), report.forwardedBy ?? '—')}</Muted>
            </Row>
            <SupportFacts report={report} />
            {report.boardId && <Muted as="div">{s.board(report.boardId)}</Muted>}
            {report.tableId && <Muted as="div">{s.table(report.tableId)}</Muted>}
            <Row>
              <Button
                type="button"
                $size="sm"
                $busy={busy === key}
                onClick={() => void run(key, () => api.platform.setSupportStatus(report.clubId, report.id, open ? 'resolved' : 'open'), open ? s.resolvedToast : s.reopenedToast)}
              >
                {open ? s.resolve : s.reopen}
              </Button>
            </Row>
          </Item>
        )
      })}
    </Card>
  )
}
