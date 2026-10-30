import { useState, type FormEvent } from 'react'
import styled from 'styled-components'
import { BOARD_RULINGS, RULING_SCORE_MAX, type BoardRuling, type BoardRulingKind } from '../../shared/board-events.ts'
import type { Side } from '../../shared/cards.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { TEAM_MATCH_LIMITS } from '../../shared/team-match.ts'
import { api } from '../lib/api.ts'
import { rulingLabel } from '../lib/rulings.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, ErrorText, Field, FieldLabel, Input, Select } from './ui.tsx'

/**
 * A director's ruling on a finished board (`e2-t35`): what it is, in a few words (the record page
 * and the history list), and on the record page the host's or an admin's form to give one or take
 * it back. The server checks who may (`ClubService.ruleBoard`)
 */

const SIDES: Side[] = ['NS', 'EW']

const Form = styled.form`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 12px;
  margin: 8px 0 12px;
`

const Shown = styled.p`
  margin: 0 0 8px;
  color: ${({ theme }) => theme.colors.text};
  & > small {
    color: ${({ theme }) => theme.colors.textMuted};
  }
`

export function RulingPanel({ record, onRuled }: { record: BoardRecord; onRuled: (ruling: BoardRuling | undefined) => void }) {
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const [kind, setKind] = useState<BoardRulingKind>('avg')
  const [side, setSide] = useState<Side>('NS')
  const [score, setScore] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const director = !!user && (user.admin || record.hostId === user.id)
  const ruling = record.ruling

  const send = async (request: Parameters<typeof api.ruleBoard>[1]) => {
    setBusy(true)
    setError('')
    try {
      const { record: saved } = await api.ruleBoard(record.id, request)
      onRuled(saved.ruling)
      setReason('')
    } catch (err) {
      const e = err as { code?: string; params?: Record<string, string | number>; message: string }
      setError(message(e.code ?? '', e.params, e.message))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send({
      kind,
      reason,
      ...((kind === 'avgPlus' || kind === 'avgMinus') && { side }),
      ...(kind === 'score' && { scoreNS: Number(score) }),
    })
  }

  return (
    <>
      {ruling && (
        <Shown role="status">
          <strong>
            {t.director.ruling} {rulingLabel(t, ruling)}
          </strong>{' '}
          {ruling.reason} <small>{t.director.ruledBy(ruling.by.username)}</small>
        </Shown>
      )}
      {director && (
        <Form onSubmit={submit} aria-label={t.director.ruleBoard}>
          <Field>
            <FieldLabel htmlFor="ruling-kind">{t.director.ruleBoard}</FieldLabel>
            <Select id="ruling-kind" $size="sm" value={kind} onChange={(e) => setKind(e.target.value as BoardRulingKind)}>
              {BOARD_RULINGS.map((k) => (
                <option key={k} value={k}>
                  {t.director.kinds[k]}
                </option>
              ))}
            </Select>
          </Field>
          {(kind === 'avgPlus' || kind === 'avgMinus') && (
            <Field>
              <FieldLabel htmlFor="ruling-side">{t.director.side}</FieldLabel>
              <Select id="ruling-side" $size="sm" value={side} onChange={(e) => setSide(e.target.value as Side)}>
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {kind === 'score' && (
            <Field>
              <FieldLabel htmlFor="ruling-score">{t.director.scoreNS}</FieldLabel>
              <Input
                id="ruling-score"
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
          <Field>
            <FieldLabel htmlFor="ruling-reason">{t.director.reason}</FieldLabel>
            <Input id="ruling-reason" $size="sm" maxLength={TEAM_MATCH_LIMITS.reasonMax} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div>
            <Button type="submit" $size="sm" $variant="primary" disabled={busy || !reason.trim() || (kind === 'score' && score === '')}>
              {t.director.submit}
            </Button>
          </div>
          {ruling && (
            <div>
              <Button type="button" $size="sm" disabled={busy} onClick={() => void send(null)}>
                {t.director.remove}
              </Button>
            </div>
          )}
          {error && <ErrorText role="alert">{error}</ErrorText>}
        </Form>
      )}
    </>
  )
}
