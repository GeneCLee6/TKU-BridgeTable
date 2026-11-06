import { GraduationCap } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { SEATS, type Seat } from '../../shared/cards.ts'
import type { TableTeach } from '../../shared/protocol.ts'
import { TEACH_TEXT_MAX, type TeachMarkInput } from '../../shared/teaching.ts'
import { TEACH_TOOLS, type TeachMarking } from '../lib/useTeachMarking.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { FeltButton } from './TablePanels.tsx'

/**
 * A teaching table's buttons (`e10-t10`, `e10-t11`): the teacher's undo, replay, next board and who
 * sees the hands; while paused the tools that mark the table. The server checks everything again
 * and decides who gets which mark (`worker/views.ts`); the page only asks.
 */

const Wrap = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;

  & > small {
    font-weight: 400;
    opacity: 0.85;
  }
`

/** Two to a row where there is room: there are many, and the hands should stay in view */
const Buttons = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
  gap: 6px;
  width: 100%;

  & > button {
    min-width: 0;
    padding-inline: 6px;
  }
`

const Tools = styled.form`
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  max-width: 300px;
  padding: 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 13px;

  & > input[type='text'] {
    flex: 1 1 120px;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.surface};
    color: ${({ theme }) => theme.colors.text};
  }
  & > small {
    flex: 1 1 100%;
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

/** The title of a teaching table: which of the chosen deals is on it */
export function TeachBanner({ teach, number }: { teach: TableTeach; number: number }) {
  const t = useT()
  const problem = teach.problem
  return (
    <Wrap>
      <GraduationCap size={15} aria-hidden />
      <span>{t.teach.title(number)}</span>
      {problem && (
        <small>
          {[
            t.practiceProblem(problem.seq, problem.count),
            ...(problem.title ? [problem.title] : []),
          ].join(' · ')}
        </small>
      )}
    </Wrap>
  )
}

export function TeachControls({
  teach,
  hasBoard,
  marking,
  seatName,
  send,
  onEnd,
}: {
  teach: TableTeach
  hasBoard: boolean
  marking: TeachMarking
  seatName: (seat: Seat) => string
  send: (
    message:
      | { type: 'teachUndo' | 'teachReplay' | 'redeal' }
      | { type: 'teachPause'; paused: boolean }
      | { type: 'showHands'; show: boolean }
      | { type: 'teachMark'; mark: TeachMarkInput }
      | { type: 'teachUnmark' },
  ) => void
  onEnd: () => void
}) {
  const t = useT()
  const [text, setText] = useState('')
  const [textSeat, setTextSeat] = useState<Seat | ''>('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const words = text.trim()
    if (!words) return
    send({
      type: 'teachMark',
      mark: { kind: 'text', text: words, ...(textSeat && { seat: textSeat }) },
    })
    setText('')
  }
  return (
    <>
      <Buttons>
        {hasBoard && (
          <>
            <FeltButton
              type="button"
              $tone="plain"
              aria-pressed={teach.paused}
              title={t.teach.pauseHint}
              onClick={() => send({ type: 'teachPause', paused: !teach.paused })}
            >
              {teach.paused ? t.teach.resume : t.teach.pause}
            </FeltButton>
            <FeltButton
              type="button"
              $tone="plain"
              disabled={!teach.canUndo}
              title={t.teach.undoHint}
              onClick={() => send({ type: 'teachUndo' })}
            >
              {t.teach.undo}
            </FeltButton>
            <FeltButton
              type="button"
              $tone="plain"
              title={t.teach.replayHint}
              onClick={() => send({ type: 'teachReplay' })}
            >
              {t.teach.replay}
            </FeltButton>
          </>
        )}
        <FeltButton type="button" $tone="plain" onClick={() => send({ type: 'redeal' })}>
          {hasBoard ? t.teach.next : t.teach.first}
        </FeltButton>
        <FeltButton
          type="button"
          $tone="plain"
          aria-pressed={teach.openHands}
          title={t.teach.openHandsHint}
          onClick={() => send({ type: 'showHands', show: !teach.openHands })}
        >
          {teach.openHands ? t.teach.hideHands : t.teach.openHands}
        </FeltButton>
        <FeltButton type="button" $tone="plain" onClick={onEnd}>
          {t.teach.end}
        </FeltButton>
      </Buttons>
      {teach.paused && (
        <Tools onSubmit={submit} aria-label={t.teach.toolsLabel}>
          {TEACH_TOOLS.map((tool) => (
            <FeltButton
              key={tool}
              type="button"
              $tone={marking.tool === tool ? 'go' : 'plain'}
              aria-pressed={marking.tool === tool}
              onClick={() => marking.setTool(tool)}
            >
              {t.teach.tools[tool]}
            </FeltButton>
          ))}
          <FeltButton
            type="button"
            $tone="plain"
            disabled={!teach.marks.length}
            onClick={() => send({ type: 'teachUnmark' })}
          >
            {t.teach.clear}
          </FeltButton>
          {marking.tool === 'arrow' &&
            SEATS.map((seat) => (
              <FeltButton
                key={seat}
                type="button"
                $tone="plain"
                onClick={() => marking.target({ seat })}
              >
                {seatName(seat)}
              </FeltButton>
            ))}
          {marking.tool === 'text' && (
            <>
              <input
                type="text"
                value={text}
                maxLength={TEACH_TEXT_MAX}
                aria-label={t.teach.textLabel}
                placeholder={t.teach.textLabel}
                onChange={(event) => setText(event.target.value)}
              />
              <select
                aria-label={t.teach.textSeat}
                value={textSeat}
                onChange={(event) => setTextSeat(event.target.value as Seat | '')}
              >
                <option value="">{t.teach.textCenter}</option>
                {SEATS.map((seat) => (
                  <option key={seat} value={seat}>
                    {seatName(seat)}
                  </option>
                ))}
              </select>
              <FeltButton type="submit" $tone="plain" disabled={!text.trim()}>
                {t.teach.textAdd}
              </FeltButton>
            </>
          )}
          <small role="status">
            {
              t.teach.toolHint[
                marking.tool === 'arrow' && marking.arrowFrom ? 'arrowTo' : marking.tool
              ]
            }
          </small>
        </Tools>
      )}
    </>
  )
}
