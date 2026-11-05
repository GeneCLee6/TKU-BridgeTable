import { useId, useState } from 'react'
import styled from 'styled-components'
import { IMPORT_LIMITS } from '../../shared/imports.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { ErrorText, FieldLabel, Textarea } from './ui.tsx'

/**
 * Where a file's text comes from (`e4-t39`, `e10-t09`): a file chosen or text pasted, either at most
 * IMPORT_LIMITS.fileBytes. It is read here in the browser; what to do with it is the caller's.
 */

const Box = styled.div`
  display: grid;
  gap: 6px;
`

const tooLarge = (size: number) => size > IMPORT_LIMITS.fileBytes

export function ImportSource({ value, onChange, accept }: { value: string; onChange: (text: string) => void; accept: string }) {
  const { t, message } = usePreferences()
  const fileId = useId()
  const pasteId = useId()
  const [error, setError] = useState('')
  const refuse = () => setError(message('importTooLarge', { max: IMPORT_LIMITS.fileBytes / (1024 * 1024) }))

  const choose = async (file: File | undefined) => {
    setError('')
    if (!file) return
    if (tooLarge(file.size)) return refuse()
    try {
      onChange(await file.text())
    } catch {
      setError(t.boardImport.failed)
    }
  }
  const paste = (text: string) => {
    setError('')
    // In characters, which a file's size in bytes is never below
    if (tooLarge(text.length)) return refuse()
    onChange(text)
  }

  return (
    <Box>
      <FieldLabel htmlFor={fileId}>{t.boardImport.file}</FieldLabel>
      <input id={fileId} type="file" accept={accept} onChange={(event) => void choose(event.target.files?.[0])} />
      <FieldLabel htmlFor={pasteId}>{t.boardImport.paste}</FieldLabel>
      <Textarea id={pasteId} $size="sm" rows={4} spellCheck={false} value={value} onChange={(event) => paste(event.target.value)} />
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Box>
  )
}

/** What is wrong with what was read, each naming its board; the first few, and how many more */
export function ImportProblems({ problems }: { problems: { board: number; code: string }[] }) {
  const { t, message } = usePreferences()
  if (!problems.length) return null
  const SHOWN = 10
  return (
    <div role="alert">
      <ErrorText as="p">{t.boardImport.problems(problems.length)}</ErrorText>
      <ul>
        {problems.slice(0, SHOWN).map((problem, i) => (
          <li key={i}>{message(problem.code, { board: problem.board })}</li>
        ))}
        {problems.length > SHOWN && <li>{t.boardImport.moreProblems(problems.length - SHOWN)}</li>}
      </ul>
    </div>
  )
}
