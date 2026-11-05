import { useEffect, useId, useMemo, useState } from 'react'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { IMPORT_LIMITS, seatNamed, type ImportedBoard } from '../../shared/imports.ts'
import { parseLin } from '../../shared/lin-import.ts'
import { api, ApiError } from '../lib/api.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ImportProblems, ImportSource } from './ImportSource.tsx'
import { Backdrop, Buttons, Panel } from './TableSettingsDialog.tsx'
import { Button, ErrorText, Field, FieldHint, FieldLabel, Input, Muted, Select } from './ui.tsx'

/**
 * Importing boards from BBO's LIN (`e4-t39`, AC-4.13, ARCHITECTURE.md §5.3). The file is parsed here
 * and sent a batch at a time, since the free plan gives a request 10 ms of CPU; the server plays each
 * board through the engine again. The member says who they were, by the name they use on BBO or a
 * seat, and that is only used to know their seat on those boards: the other names stay text.
 */

const session = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')

export function LinImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { t, message } = usePreferences()
  const titleId = useId()
  const nameId = useId()
  const seatId = useId()
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [seat, setSeat] = useState<Seat>('S')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null)
  const parsed = useMemo(() => (text.trim() ? parseLin(text) : null), [text])
  const count = parsed?.boards.length ?? 0
  const tooMany = count > IMPORT_LIMITS.linBoards
  const nothing = !!parsed && !count && !parsed.problems.length

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (!parsed || !count || tooMany) return
    const boards: ImportedBoard[] = parsed.boards.map((board) => ({ ...board, seat: seatNamed(board.names, name) ?? seat }))
    const id = session()
    let added = 0
    let duplicates = 0
    setNote(null)
    setProgress({ done: 0, total: boards.length })
    try {
      for (let at = 0; at < boards.length; at += IMPORT_LIMITS.batchBoards) {
        const batch = await api.importBoards(boards.slice(at, at + IMPORT_LIMITS.batchBoards), id)
        added += batch.added
        duplicates += batch.duplicates
        setProgress({ done: Math.min(boards.length, at + IMPORT_LIMITS.batchBoards), total: boards.length })
      }
      setNote({ error: false, text: t.boardImport.done(added, duplicates) })
      setText('')
    } catch (error) {
      setNote({ error: true, text: error instanceof ApiError ? message(error.code, error.params, error.message) : t.boardImport.failed })
    } finally {
      setProgress(null)
      // What went in before a batch was refused is there all the same
      if (added) onImported()
    }
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.boardImport.linTitle}</h2>
        <Muted>{t.boardImport.linIntro}</Muted>
        <ImportSource value={text} onChange={setText} accept=".lin,.txt,text/plain" />
        {nothing && <ErrorText role="alert">{message('importNoBoards')}</ErrorText>}
        {tooMany && <ErrorText role="alert">{message('importTooManyBoards', { max: IMPORT_LIMITS.linBoards })}</ErrorText>}
        {parsed && <ImportProblems problems={parsed.problems} />}
        {count > 0 && !tooMany && (
          <>
            <Muted role="status">{t.boardImport.ready(count)}</Muted>
            <Field>
              <FieldLabel htmlFor={nameId}>{t.boardImport.myName}</FieldLabel>
              <Input id={nameId} $size="sm" value={name} maxLength={IMPORT_LIMITS.nameMax} onChange={(event) => setName(event.target.value)} />
              <FieldHint>{t.boardImport.myNameHint}</FieldHint>
            </Field>
            <Field>
              <FieldLabel htmlFor={seatId}>{t.boardImport.mySeat}</FieldLabel>
              <Select id={seatId} $size="sm" value={seat} onChange={(event) => setSeat(event.target.value as Seat)}>
                {SEATS.map((s) => (
                  <option key={s} value={s}>
                    {t.seatNames[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        {progress && <Muted role="status">{t.boardImport.importing(progress.done, progress.total)}</Muted>}
        {note && (note.error ? <ErrorText role="alert">{note.text}</ErrorText> : <Muted role="status">{note.text}</Muted>)}
        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.close}
          </Button>
          <Button type="button" $variant="primary" disabled={!count || tooMany || !!progress} onClick={() => void submit()}>
            {t.boardImport.submit}
          </Button>
        </Buttons>
      </Panel>
    </Backdrop>
  )
}
