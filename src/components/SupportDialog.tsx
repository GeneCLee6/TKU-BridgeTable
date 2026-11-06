import { LifeBuoy } from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { isImportedBoardId } from '../../shared/imports.ts'
import { SUPPORT_CATEGORIES, SUPPORT_LIMITS, SUPPORT_REPORTS_ANCHOR, type MySupportReport, type SupportCategory } from '../../shared/support.ts'
import { api, ApiError } from '../lib/api.ts'
import { appVersion } from '../lib/errorReport.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { panelScroll } from '../styles/controls.ts'
import { Badge } from './AdminSupport.tsx'
import { Backdrop } from './Modal.tsx'
import { useToast } from './Toast.tsx'
import { Button, Card, CardHeader, CardTitle, ErrorText, Field, FieldHint, FieldLabel, Muted, Select, Textarea } from './ui.tsx'

/**
 * 回報問題 (e12-t16, ARCHITECTURE.md §1「客服回報」): a member's report to their club's admins. The
 * page attaches its version and, when opened from a table or a record, that id; the server adds the
 * browser and the club. The form says what goes along, and nothing else does.
 */

const Panel = styled(Card)`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  width: 100%;
  max-width: 520px;
  ${panelScroll}
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0;
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: ${({ theme }) => theme.space(2)};
`

export function SupportDialog({ boardId, tableId, onClose, onSent }: { boardId?: string; tableId?: string; onClose: () => void; onSent?: () => void }) {
  const { t, message } = usePreferences()
  const s = t.support
  const toast = useToast()
  const id = useId()
  const [category, setCategory] = useState<SupportCategory>('bug')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.sendSupportReport({
        category,
        text,
        version: appVersion(),
        ...(boardId && { boardId }),
        ...(tableId && { tableId }),
      })
      toast.success(s.sent)
      onSent?.()
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel as="form" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <h2 id={`${id}-title`}>{s.open}</h2>
        <Muted>{s.intro}</Muted>
        <Field>
          <FieldLabel htmlFor={`${id}-category`}>{s.category}</FieldLabel>
          <Select id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value as SupportCategory)}>
            {SUPPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {s.categories[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-text`}>{s.text}</FieldLabel>
          <Textarea id={`${id}-text`} rows={5} maxLength={SUPPORT_LIMITS.textMax} value={text} onChange={(e) => setText(e.target.value)} required />
          {/* An imported board's id means nothing to whoever reads this: it says they cannot open it (ARCHITECTURE.md §1「客服回報」) */}
          <FieldHint>{boardId ? (isImportedBoardId(boardId) ? s.attachedImported : s.attachedBoard(boardId)) : tableId ? s.attachedTable(tableId) : s.attached}</FieldHint>
        </Field>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" $variant="primary" $busy={busy}>
            {s.send}
          </Button>
        </Buttons>
      </Panel>
    </Backdrop>
  )
}

const Reports = styled.ul`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
  padding: 0;
  list-style: none;

  & p {
    margin: ${({ theme }) => theme.space(1)} 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`

const ReportHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
`

/** The member's own reports and how they stand; the server sends nothing about who handled them */
function MyReports({ reports }: { reports: MySupportReport[] | null }) {
  const { t, lang } = usePreferences()
  const s = t.support
  if (!reports) return null
  return (
    <section aria-label={s.mineTitle}>
      <h3>{s.mineTitle}</h3>
      {reports.length === 0 ? (
        <Muted>{s.mineNone}</Muted>
      ) : (
        <Reports>
          {reports.map((report) => (
            <li key={report.id}>
              <ReportHead>
                <strong>{s.categories[report.category]}</strong>
                <Badge $open={report.status === 'open'}>{report.status === 'open' ? s.statusOpen : s.statusResolved}</Badge>
                <Muted as="span">{formatDateTime(report.createdAt, lang)}</Muted>
              </ReportHead>
              <p>{report.text}</p>
              {report.resolvedAt !== undefined && <Muted>{s.mineResolvedAt(formatDateTime(report.resolvedAt, lang))}</Muted>}
            </li>
          ))}
        </Reports>
      )}
    </section>
  )
}

/** On 「我的帳號」: a report that is not about one table or record, and the member's reports so far */
export function SupportCard() {
  const { t } = usePreferences()
  const { hash } = useLocation()
  const [open, setOpen] = useState(false)
  const [reports, setReports] = useState<MySupportReport[] | null>(null)

  // The list is extra: when it cannot be read the card still sends
  const read = useCallback(() => {
    api.mySupportReports().then(
      (found) => setReports(found.reports),
      () => undefined,
    )
  }, [])
  useEffect(read, [read])

  // The link of `supportResolved`: the list is below the fold of a long page
  const loaded = reports !== null
  useEffect(() => {
    if (loaded && hash === `#${SUPPORT_REPORTS_ANCHOR}`) document.getElementById(SUPPORT_REPORTS_ANCHOR)?.scrollIntoView?.({ block: 'start' })
  }, [loaded, hash])

  return (
    <Card id={SUPPORT_REPORTS_ANCHOR}>
      <CardHeader>
        <CardTitle>{t.support.open}</CardTitle>
        <Muted>{t.support.cardHint}</Muted>
      </CardHeader>
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          <LifeBuoy size={16} aria-hidden />
          {t.support.open}
        </Button>
      </div>
      <MyReports reports={reports} />
      {open && <SupportDialog onSent={read} onClose={() => setOpen(false)} />}
    </Card>
  )
}
