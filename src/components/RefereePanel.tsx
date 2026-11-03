import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { BOARD_RULINGS, RULING_SCORE_MAX, type BoardRulingKind } from '../../shared/board-events.ts'
import type { Side } from '../../shared/cards.ts'
import type { Lang } from '../../shared/messages.ts'
import { REFEREE_LIMITS, type RefereeEvent, type RefereeNote, type RefereeRequest } from '../../shared/referee.ts'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { rulingLabel } from '../lib/rulings.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import type { Strings } from '../strings.ts'
import { Button, ErrorText, Field, FieldLabel, Input, Muted, Select } from './ui.tsx'

/**
 * The tournament director's tools (裁判工具, `e9-t17`, AC-9.8): on an event's result page, what the
 * director did (`RefereeNotes`, everyone who sees the event; the server leaves out a board's note
 * until its traveller is shown), and for the director the form (`RefereeTools`). The server checks
 * who may and what (`ClubService.refereeAct`); the page reads the event again after each.
 */

const List = styled.ul`
  margin: 0 0 8px;
  padding: 0;
  list-style: none;

  & > li {
    padding: 6px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
  & > li:first-child {
    border-top: 0;
  }
  & small {
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

const Withdrawn = styled.span`
  margin-left: 6px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
`

const Form = styled.form`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
  margin: 8px 0 4px;
`

const Boxes = styled.fieldset`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  padding: 4px 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};

  & > legend {
    font-size: 13px;
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

const amountText = (amount: number) => (Number.isInteger(amount) ? String(amount) : amount.toFixed(1))

/** One note in a few words: what, on which board or whom, and how much */
function noteText(t: Strings, note: RefereeNote, targetLabel: (target: string) => string, unit: string, lang?: Lang): string {
  const r = t.referee
  switch (note.action) {
    case 'score': {
      const where =
        note.boardNo !== undefined && note.table !== undefined && note.round !== undefined
          ? r.boardAt(note.round, note.table, note.boardNo)
          : note.boardNo !== undefined
            ? r.board(note.boardNo)
            : r.aBoard
      return `${r.actions.score} · ${where} · ${note.ruling ? r.ruled(rulingLabel(t, note.ruling)) : r.ruleRemoved}`
    }
    case 'penalty':
      return `${r.actions.penalty} · ${r.penaltyNote(targetLabel(note.target), `${amountText(note.amount)} ${unit}`)}`
    case 'withdraw':
      return r.withdrawNote
    case 'delay':
      return note.until === null ? r.delayLifted : r.delayNote(formatDateTime(note.until, lang))
    case 'restart':
      return [r.restartNote(note.round, note.table), ...(note.replay.length ? [r.replayNote(note.replay.join(', '))] : [])].join(' · ')
  }
}

/** What the director did in the event, oldest first, with who, when and why */
export function RefereeNotes({
  notes,
  targetLabel,
  unit,
}: {
  notes: RefereeNote[]
  targetLabel: (target: string) => string
  unit: string
}) {
  const { t, lang } = usePreferences()
  if (!notes.length) return null
  return (
    <List aria-label={t.referee.notes}>
      {notes.map((note) => (
        <li key={note.id}>
          <strong>{noteText(t, note, targetLabel, unit, lang)}</strong>
          {note.withdrawn && <Withdrawn>{t.referee.withdrawn}</Withdrawn>}
          {note.reason && <> · {note.reason}</>}
          <br />
          <small>
            {t.referee.by(note.by.username || t.deletedMember)} · {formatDateTime(note.at, lang)}
          </small>
        </li>
      ))}
    </List>
  )
}

type Tool = 'score' | 'penalty' | 'withdraw' | 'delay' | 'restart'

export interface RefereeTable {
  table: number
  boards: number[]
  label: string
}

/** The director's form: one tool at a time, each with its reason */
export function RefereeTools({
  kind,
  eventId,
  targets,
  targetLabel,
  unit,
  notes,
  tables = [],
  canDelay = false,
  onDone,
}: {
  kind: RefereeEvent
  eventId: string
  /** Whom a penalty may be for (none: no penalty yet, e.g. before the start) */
  targets: { value: string; label: string }[]
  targetLabel: (target: string) => string
  /** What a penalty is in: MP, IMPs, … */
  unit: string
  notes: RefereeNote[]
  /** A pairs event being played: the round's tables, for a board's score and re-opening one */
  tables?: RefereeTable[]
  /** A pairs event before its start */
  canDelay?: boolean
  onDone: () => void
}) {
  const { t, message } = usePreferences()
  const r = t.referee
  const penalties = notes.filter((n) => n.action === 'penalty' && !n.withdrawn)
  const tools: Tool[] = [
    ...(tables.length ? (['score', 'restart'] as const) : []),
    ...(targets.length ? (['penalty'] as const) : []),
    ...(penalties.length ? (['withdraw'] as const) : []),
    ...(canDelay ? (['delay'] as const) : []),
  ]
  const [chosen, setTool] = useState<Tool | ''>('')
  const tool = chosen && tools.includes(chosen) ? chosen : (tools[0] ?? '')
  const [target, setTarget] = useState('')
  const [amount, setAmount] = useState('')
  const [of, setOf] = useState('')
  const [minutes, setMinutes] = useState('15')
  const [table, setTable] = useState('')
  const [board, setBoard] = useState('')
  const [replay, setReplay] = useState<number[]>([])
  const [ruling, setRuling] = useState<BoardRulingKind>('avg')
  const [side, setSide] = useState<Side>('NS')
  const [score, setScore] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!tool) return <Muted>{r.noTools}</Muted>
  const chosenTable = tables.find((x) => String(x.table) === table) ?? tables[0]
  const targetValue = targets.some((x) => x.value === target) ? target : (targets[0]?.value ?? '')
  const penaltyValue = penalties.some((p) => p.id === of) ? of : (penalties[0]?.id ?? '')
  const boardValue = chosenTable?.boards.includes(Number(board)) ? Number(board) : (chosenTable?.boards[0] ?? 0)

  const request = (): RefereeRequest | null => {
    const why = reason.trim()
    switch (tool) {
      case 'penalty':
        return { action: 'penalty', target: targetValue, amount: Number(amount), reason: why }
      case 'withdraw':
        return { action: 'withdraw', of: penaltyValue, reason: why }
      case 'delay':
        return { action: 'delay', minutes: Number(minutes), reason: why }
      case 'restart':
        return chosenTable ? { action: 'restart', table: chosenTable.table, replay: replay.filter((b) => chosenTable.boards.includes(b)), reason: why } : null
      case 'score':
        return chosenTable
          ? {
              action: 'score',
              table: chosenTable.table,
              boardNo: boardValue,
              ruling: {
                kind: ruling,
                reason: why,
                ...((ruling === 'avgPlus' || ruling === 'avgMinus') && { side }),
                ...(ruling === 'score' && { scoreNS: Number(score) }),
              },
            }
          : null
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const body = request()
    if (!body) return
    setBusy(true)
    setError('')
    try {
      await api.referee(kind, eventId, body)
      setReason('')
      setAmount('')
      setReplay([])
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : String(err))
    } finally {
      setBusy(false)
    }
  }

  const ready =
    !!reason.trim() &&
    (tool !== 'penalty' || (Number(amount) > 0 && !!targetValue)) &&
    (tool !== 'score' || ruling !== 'score' || score !== '')

  return (
    <>
      {tool === 'score' && <Muted>{r.scoreHint}</Muted>}
      {tool === 'restart' && <Muted>{r.restartHint}</Muted>}
      {(tool === 'penalty' || tool === 'withdraw') && <Muted>{r.penaltyHint}</Muted>}
      <Form onSubmit={(e) => void submit(e)} aria-label={r.title}>
        <Field>
          <FieldLabel htmlFor="referee-tool">{r.tool}</FieldLabel>
          <Select id="referee-tool" $size="sm" value={tool} onChange={(e) => setTool(e.target.value as Tool)}>
            {tools.map((x) => (
              <option key={x} value={x}>
                {r.actions[x]}
              </option>
            ))}
          </Select>
        </Field>
        {tool === 'penalty' && (
          <>
            <Field>
              <FieldLabel htmlFor="referee-target">{r.target}</FieldLabel>
              <Select id="referee-target" $size="sm" value={targetValue} onChange={(e) => setTarget(e.target.value)}>
                {targets.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="referee-amount">{r.amount(unit)}</FieldLabel>
              <Input
                id="referee-amount"
                $size="sm"
                type="number"
                min={0.1}
                step={0.1}
                max={REFEREE_LIMITS.penaltyMax}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </>
        )}
        {tool === 'withdraw' && (
          <Field>
            <FieldLabel htmlFor="referee-of">{r.penaltyOf}</FieldLabel>
            <Select id="referee-of" $size="sm" value={penaltyValue} onChange={(e) => setOf(e.target.value)}>
              {penalties.map((p) => (
                <option key={p.id} value={p.id}>
                  {noteText(t, p, targetLabel, unit)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {tool === 'delay' && (
          <Field>
            <FieldLabel htmlFor="referee-minutes">{r.minutes}</FieldLabel>
            <Input
              id="referee-minutes"
              $size="sm"
              type="number"
              min={0}
              max={REFEREE_LIMITS.delayMinutesMax}
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </Field>
        )}
        {(tool === 'score' || tool === 'restart') && (
          <Field>
            <FieldLabel htmlFor="referee-table">{r.table}</FieldLabel>
            <Select id="referee-table" $size="sm" value={chosenTable?.table ?? ''} onChange={(e) => setTable(e.target.value)}>
              {tables.map((x) => (
                <option key={x.table} value={x.table}>
                  {x.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {tool === 'score' && chosenTable && (
          <>
            <Field>
              <FieldLabel htmlFor="referee-board">{r.boardNo}</FieldLabel>
              <Select id="referee-board" $size="sm" value={boardValue} onChange={(e) => setBoard(e.target.value)}>
                {chosenTable.boards.map((b) => (
                  <option key={b} value={b}>
                    {r.board(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="referee-ruling">{t.director.ruling}</FieldLabel>
              <Select id="referee-ruling" $size="sm" value={ruling} onChange={(e) => setRuling(e.target.value as BoardRulingKind)}>
                {BOARD_RULINGS.map((k) => (
                  <option key={k} value={k}>
                    {t.director.kinds[k]}
                  </option>
                ))}
              </Select>
            </Field>
            {(ruling === 'avgPlus' || ruling === 'avgMinus') && (
              <Field>
                <FieldLabel htmlFor="referee-side">{t.director.side}</FieldLabel>
                <Select id="referee-side" $size="sm" value={side} onChange={(e) => setSide(e.target.value as Side)}>
                  <option value="NS">NS</option>
                  <option value="EW">EW</option>
                </Select>
              </Field>
            )}
            {ruling === 'score' && (
              <Field>
                <FieldLabel htmlFor="referee-score">{t.director.scoreNS}</FieldLabel>
                <Input
                  id="referee-score"
                  $size="sm"
                  type="number"
                  step={10}
                  min={-RULING_SCORE_MAX}
                  max={RULING_SCORE_MAX}
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        {tool === 'restart' && chosenTable && (
          <Boxes>
            <legend>{r.replay}</legend>
            {chosenTable.boards.map((b) => (
              <label key={b}>
                <input
                  type="checkbox"
                  checked={replay.includes(b)}
                  onChange={(e) => setReplay((list) => (e.target.checked ? [...list, b] : list.filter((x) => x !== b)))}
                />{' '}
                {r.board(b)}
              </label>
            ))}
          </Boxes>
        )}
        <Field>
          <FieldLabel htmlFor="referee-reason">{r.reason}</FieldLabel>
          <Input
            id="referee-reason"
            $size="sm"
            maxLength={REFEREE_LIMITS.reasonMax}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" $size="sm" $variant="primary" disabled={busy || !ready}>
            {r.submit}
          </Button>
        </div>
        {error && <ErrorText role="alert">{error}</ErrorText>}
      </Form>
    </>
  )
}
