import { useCallback, useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { NOTICE_LIMITS, type ClubBanner } from '../../shared/notices.ts'
import type { AdminSupportReport, AdminSupportView, ForwardedSupport } from '../../shared/support.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { fromLocalInput, localInput } from '../lib/forumRelease.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { useToast } from './Toast.tsx'
import { Button, ErrorText, Field, FieldHint, FieldLabel, Input, Muted, Textarea } from './ui.tsx'

/**
 * The admin page's two sections of e12-t15 and e12-t16: the club's own banner, and the members'
 * support reports with their status and forwarding to the platform owner. The server checks who
 * may on every request (`ClubService.requireAdmin`).
 */

const Item = styled.article`
  display: grid;
  gap: ${({ theme }) => theme.space(1)};
  padding: ${({ theme }) => theme.space(3)} 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  & > p {
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

const Badge = styled.span<{ $open: boolean }>`
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $open }) => ($open ? theme.colors.accentSoft : theme.colors.successSoft)};
`

const Small = styled(Muted)`
  font-size: 13px;
  overflow-wrap: anywhere;
`

const Form = styled.form`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
`

/** What a report carries besides its text, the same for the admin page and the back office */
export function SupportFacts({ report }: { report: ForwardedSupport | AdminSupportReport }) {
  const { t, lang } = usePreferences()
  const s = t.support
  return (
    <>
      <Row>
        <strong>{s.categories[report.category]}</strong>
        <Badge $open={report.status === 'open'}>{report.status === 'open' ? s.statusOpen : s.statusResolved}</Badge>
        <Muted as="span">{formatDateTime(report.createdAt, lang)}</Muted>
      </Row>
      <p>{report.text}</p>
      <Small as="div">{s.browser(report.browser)}</Small>
      <Small as="div">{s.version(report.version)}</Small>
    </>
  )
}

function ReportItem({
  report,
  canForward,
  busy,
  run,
}: {
  report: AdminSupportReport
  canForward: boolean
  busy: string | null
  run: (key: string, action: () => Promise<AdminSupportView>, done: string) => void
}) {
  const { t, lang } = usePreferences()
  const s = t.support
  const open = report.status === 'open'
  return (
    <Item aria-label={s.reportBy(report.username)}>
      <SupportFacts report={report} />
      <Small as="div">{s.reportBy(report.username)}</Small>
      {report.boardId && (
        <Small as="div">
          <Link to={`/history/${encodeURIComponent(report.boardId)}`}>{s.board(report.boardId)}</Link>
        </Small>
      )}
      {report.tableId && <Small as="div">{s.table(report.tableId)}</Small>}
      {report.forwardedAt !== undefined && <Small as="div">{s.forwardedAt(formatDateTime(report.forwardedAt, lang), report.forwardedBy ?? '—')}</Small>}
      <Row>
        <Button
          type="button"
          $size="sm"
          $busy={busy === `status-${report.id}`}
          onClick={() => run(`status-${report.id}`, () => api.admin.setSupportStatus(report.id, open ? 'resolved' : 'open'), open ? s.resolvedToast : s.reopenedToast)}
        >
          {open ? s.resolve : s.reopen}
        </Button>
        {canForward && report.forwardedAt === undefined && (
          <Button type="button" $size="sm" $busy={busy === `forward-${report.id}`} onClick={() => run(`forward-${report.id}`, () => api.admin.forwardSupport(report.id), s.forwardedToast)}>
            {s.forward}
          </Button>
        )}
      </Row>
    </Item>
  )
}

export function AdminSupport() {
  const { t, message } = usePreferences()
  const toast = useToast()
  const [view, setView] = useState<AdminSupportView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const failed = useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])

  useEffect(() => {
    let live = true
    api.admin.support().then(
      (found) => live && setView(found),
      (e: unknown) => live && setError(failed(e)),
    )
    return () => {
      live = false
    }
  }, [failed])

  const run = (key: string, action: () => Promise<AdminSupportView>, done: string) => {
    setBusy(key)
    action()
      .then((found) => {
        setView(found)
        toast.success(done)
      })
      .catch((e: unknown) => toast.error(failed(e)))
      .finally(() => setBusy(null))
  }

  if (error) return <ErrorText role="alert">{error}</ErrorText>
  if (!view) return <Muted>{t.loading}</Muted>
  if (!view.reports.length) return <Muted>{t.support.none}</Muted>
  return (
    <div>
      {view.reports.map((report) => (
        <ReportItem key={report.id} report={report} canForward={view.canForward} busy={busy} run={run} />
      ))}
    </div>
  )
}

export function AdminBanner() {
  const { t, lang, message } = usePreferences()
  const n = t.notices
  const toast = useToast()
  const id = useId()
  const [banner, setBanner] = useState<ClubBanner | null | undefined>(undefined)
  const [text, setText] = useState('')
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const failed = useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])

  const show = useCallback((found: ClubBanner | null) => {
    setBanner(found)
    setText(found?.text ?? '')
    setUntil(found?.expiresAt !== undefined ? localInput(found.expiresAt) : '')
  }, [])

  useEffect(() => {
    let live = true
    api.admin.banner().then(
      (found) => live && show(found.banner),
      (e: unknown) => {
        if (!live) return
        setBanner(null)
        toast.error(failed(e))
      },
    )
    return () => {
      live = false
    }
  }, [show, failed, toast])

  const run = async (action: () => Promise<{ banner: ClubBanner | null }>, done: string) => {
    setBusy(true)
    try {
      show((await action()).banner)
      toast.success(done)
    } catch (e) {
      toast.error(failed(e))
    } finally {
      setBusy(false)
    }
  }

  if (banner === undefined) return <Muted>{t.loading}</Muted>
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault()
        void run(() => api.admin.setBanner({ text, expiresAt: fromLocalInput(until) ?? null }), n.bannerSaved)
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
      {banner && <Muted>{n.bannerShown(formatDateTime(banner.setAt, lang))}</Muted>}
      <Row>
        <Button type="submit" $variant="primary" $busy={busy}>
          {n.bannerSave}
        </Button>
        {banner && (
          <Button type="button" disabled={busy} onClick={() => void run(async () => api.admin.clearBanner(), n.bannerCleared)}>
            {n.bannerClear}
          </Button>
        )}
      </Row>
    </Form>
  )
}
