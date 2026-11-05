import { LifeBuoy } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { SUPPORT_CATEGORIES, SUPPORT_LIMITS, type SupportCategory } from '../../shared/support.ts'
import { api, ApiError } from '../lib/api.ts'
import { appVersion } from '../lib/errorReport.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { panelScroll } from '../styles/controls.ts'
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

export function SupportDialog({ boardId, tableId, onClose }: { boardId?: string; tableId?: string; onClose: () => void }) {
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
          <FieldHint>{boardId ? s.attachedBoard(boardId) : tableId ? s.attachedTable(tableId) : s.attached}</FieldHint>
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

/** On 「我的帳號」: a report that is not about one table or record */
export function SupportCard() {
  const { t } = usePreferences()
  const [open, setOpen] = useState(false)
  return (
    <Card>
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
      {open && <SupportDialog onClose={() => setOpen(false)} />}
    </Card>
  )
}
