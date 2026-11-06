import { memo, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { BoardRecord } from '../../shared/protocol.ts'
import { CardName, DdStepVerdict } from '../components/DoubleDummyReplay.tsx'
import { ContractResult } from '../components/Suit.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useBoardAnalyses, type BoardAnalysis } from '../lib/ddAnalysis.ts'
import { biggestLosses, hasSteps, stepTotals } from '../lib/ddSteps.ts'
import { DD_STEP_BUDGET_MS } from '../lib/doubleDummy.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { boardPlace, playerName, seatLetter } from '../strings.ts'

/**
 * The post-game analysis (`e10-t12`): the boards of a session the member may read (the server's
 * `GET /api/history/:id/session`, the same rule as the record page), each with the steps that cost
 * the most double dummy. Everything is worked out in the browser, in a Web Worker, one card at a
 * time, and can be stopped. What shows is always a finished solve: while a board is being worked
 * out its list only has the steps done so far, marked as still going by the progress bar, and a
 * step over the budget is counted as too complex rather than given a number.
 */

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 12px 0 20px;
  font-size: 14px;
`

const Track = styled.div`
  flex: 1 1 200px;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

const Fill = styled.div.attrs<{ $share: number }>(({ $share }) => ({ style: { width: `${Math.round($share * 100)}%` } }))<{ $share: number }>`
  height: 100%;
  background: ${({ theme }) => theme.colors.accentStrong};
`

const BoardHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  margin-bottom: 8px;

  & > strong { font-size: 16px; }
`

const Moves = styled.ol`
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  font-size: 14px;
  line-height: 22px;

  & > li + li { margin-top: 6px; }
`

const Stack = styled.div`
  display: grid;
  gap: 12px;
`

/** Only the board being worked out draws again at each step, however long the session is */
const BoardAnalysisCard = memo(function BoardAnalysisCard({ record, analysis }: { record: BoardRecord; analysis: BoardAnalysis | undefined }) {
  const { t } = usePreferences()
  const { board, players, id } = record
  const moves = useMemo(() => biggestLosses(analysis?.steps ?? []), [analysis])
  const totals = useMemo(() => stepTotals(analysis?.steps ?? []), [analysis])
  const seconds = DD_STEP_BUDGET_MS / 1000

  return (
    <Card aria-label={t.boardNo(board.boardNo)}>
      <BoardHead>
        <strong>
          {t.boardNo(board.boardNo)} · <ContractResult contract={board.contract} tricks={board.result?.declarerTricks ?? 0} />
        </strong>
        <Link to={`/history/${encodeURIComponent(id)}`}>{t.postGame.openBoard}</Link>
      </BoardHead>
      {!board.contract && <Muted>{t.postGame.passedOut}</Muted>}
      {board.contract && !hasSteps(board) && <Muted>{t.postGame.incomplete}</Muted>}
      {hasSteps(board) && !analysis && <Muted>{t.postGame.waiting}</Muted>}
      {analysis?.failed && <Muted role="alert">{t.ddFailed}</Muted>}
      {analysis && analysis.done > 0 && (
        <>
          {analysis.finished && <Muted>{moves.length ? t.postGame.totals(totals.declarerLoss, totals.defenceLoss) : t.postGame.noLoss}</Muted>}
          {totals.tooComplex > 0 && <Muted>{t.postGame.tooComplex(totals.tooComplex, seconds)}</Muted>}
          {moves.length > 0 && (
            <Moves aria-label={t.postGame.moves}>
              {moves.map((step) => {
                const player = players[step.seat]
                return (
                  <li key={step.index}>
                    {t.postGame.trick(step.trick)} · {seatLetter[step.seat]}
                    {player && ` ${playerName(t, player)}`} · <CardName card={step.card} /> <DdStepVerdict step={step} /> ·{' '}
                    <Link to={`/history/${encodeURIComponent(id)}?step=${step.index + 1}`}>{t.postGame.showStep}</Link>
                  </li>
                )
              })}
            </Moves>
          )}
        </>
      )}
    </Card>
  )
})

export function PostGamePage() {
  const { recordId } = useParams()
  const { t, message } = usePreferences()
  const [records, setRecords] = useState<BoardRecord[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!recordId) return
    let live = true
    api
      .session(recordId)
      .then((r) => live && setRecords(r.records))
      .catch((e) => live && setError(message(e.code, e.params, e.message)))
    return () => {
      live = false
    }
  }, [recordId, message])

  const boards = useMemo(() => (records ?? []).map((r) => r.board), [records])
  const queue = useBoardAnalyses(boards)

  if (error)
    return (
      <PageMain>
        <ErrorText role="alert">{error}</ErrorText>
        <p>
          <Link to="/history">{t.backToHistory}</Link>
        </p>
      </PageMain>
    )
  if (!records) return <PageMain>{t.loading}</PageMain>

  const first = records[0]
  return (
    <PageMain>
      <PageTitle>
        {t.postGame.title}
        {first && ` · ${boardPlace(t, first)}`}
      </PageTitle>
      <Muted>{t.postGame.intro}</Muted>
      <Bar>
        <Track role="progressbar" aria-valuemin={0} aria-valuemax={queue.total} aria-valuenow={queue.done} aria-label={t.postGame.progress(queue.done, queue.total)}>
          <Fill $share={queue.total ? queue.done / queue.total : 0} />
        </Track>
        <span role="status">
          {queue.running || queue.stopped || queue.failed ? t.postGame.progress(queue.done, queue.total) : t.postGame.finished}
          {queue.stopped && ` ${t.postGame.stopped}`}
        </span>
        {queue.running && (
          <Button type="button" $small onClick={queue.stop}>
            {t.postGame.stop}
          </Button>
        )}
        {queue.stopped && (
          <Button type="button" $small onClick={queue.resume}>
            {t.postGame.resume}
          </Button>
        )}
      </Bar>
      <Stack>
        {records.map((record) => (
          <BoardAnalysisCard key={record.id} record={record} analysis={queue.analysis(record.board)} />
        ))}
      </Stack>
    </PageMain>
  )
}
