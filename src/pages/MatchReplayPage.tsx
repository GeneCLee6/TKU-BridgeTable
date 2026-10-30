import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import type { BoardRecord } from '../../shared/protocol.ts'
import type { TeamMatchView } from '../../shared/team-match.ts'
import { ScoreLine } from '../components/MatchParts.tsx'
import { ActionLink, Button, ErrorText, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { teamName } from '../lib/matches.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { SideBySide } from './ComparePage.tsx'

/**
 * The whole match replayed after it (`e8-t20`, AC-8.8): every board both rooms played, the two
 * rooms side by side and played trick by trick together (the side-by-side replay of `e4-t33`), one
 * board after another. Each record comes from `/api/history/:id`, so the server decides whether the
 * member may see it (§4): a board one room has not played yet is not in the match's list at all
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Steps = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 12px;
`

export function MatchReplayPage() {
  const { matchId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const { t, message } = usePreferences()
  const [match, setMatch] = useState<TeamMatchView | null>(null)
  const [loaded, setLoaded] = useState<{ seq: number; records: [BoardRecord, BoardRecord] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api
      .match(matchId)
      .then(({ match }) => live && setMatch(match))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [matchId, message])

  const boards = (match?.boards ?? []).filter((b) => b.open && b.closed)
  const wanted = Number(params.get('board'))
  const index = Math.max(0, boards.findIndex((b) => b.seq === wanted))
  const board = boards[index]

  useEffect(() => {
    if (!board?.open || !board.closed) return
    let live = true
    Promise.all([api.record(board.open.boardId), api.record(board.closed.boardId)])
      .then(([a, b]) => live && setLoaded({ seq: board.seq, records: [a.record, b.record] }))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)))
    return () => {
      live = false
    }
  }, [board?.seq, board?.open, board?.closed, message])

  const go = (seq: number) => setParams({ board: String(seq) }, { replace: true })
  const back = (
    <Back back to={`/matches/${encodeURIComponent(matchId)}`}>
      {t.teamMatch.title}
    </Back>
  )
  if (!match)
    return (
      <PageMain>
        {back}
        {error ? <ErrorText role="alert">{error}</ErrorText> : t.loading}
      </PageMain>
    )
  const records = loaded && loaded.seq === board?.seq ? loaded.records : null
  return (
    <PageMain>
      {back}
      <PageTitle>
        {t.teamMatch.replayAll} · {t.teamMatch.vs(teamName(t, match, 'A'), teamName(t, match, 'B'))}
      </PageTitle>
      <ScoreLine match={match} />
      <Muted>{t.teamMatch.replayNote}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {!board ? (
        <Muted>{t.teamMatch.replayNone}</Muted>
      ) : (
        <>
          <Steps>
            <Button type="button" $small disabled={index === 0} onClick={() => go(boards[index - 1].seq)} aria-label={t.teamMatch.prevBoard}>
              <ChevronLeft size={16} aria-hidden />
              {t.teamMatch.prevBoard}
            </Button>
            <Select
              aria-label={t.teamMatch.boardColumn}
              value={board.seq}
              onChange={(e) => {
                setError('')
                go(Number(e.target.value))
              }}
            >
              {boards.map((b) => (
                <option key={b.seq} value={b.seq}>
                  {t.teamMatch.boardLabel(b.seq)}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              $small
              disabled={index === boards.length - 1}
              onClick={() => go(boards[index + 1].seq)}
              aria-label={t.teamMatch.nextBoard}
            >
              {t.teamMatch.nextBoard}
              <ChevronRight size={16} aria-hidden />
            </Button>
          </Steps>
          {records ? <SideBySide key={board.seq} records={records} /> : !error && <Muted>{t.loading}</Muted>}
        </>
      )}
    </PageMain>
  )
}
