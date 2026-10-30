import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { dealerOf, vulnerabilityOf } from '../../shared/board.ts'
import { headToHead } from '../../shared/challenge-scoring.ts'
import type { ChallengeView } from '../../shared/challenge.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import type { Traveller } from '../../shared/traveller.ts'
import { TravellerTable } from '../components/Traveller.tsx'
import { ActionLink, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import {
  challengeTitle,
  formatScore,
  participantName,
  playerOf,
  resultOrder,
  tone,
  travellerRulings,
  travellerScores,
} from '../lib/challenges.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { BoardRecordView } from '../components/BoardRecordView.tsx'

/**
 * One board of a challenge (社長 2026-10-25, after BBO's challenge results): its traveller, then a
 * tab for each player with the deal, their auction and their play (`BoardRecordView`), and from the
 * traveller the side-by-side replay with anyone (`ComparePage`). The server decides what is shown:
 * the board is listed only when `challengeView` gave the member its traveller, and each record comes
 * from `/api/history/:id` (`recordVisible`, `challengeBoardVisible`, §4).
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Nav = styled.nav`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  margin-bottom: 16px;

  & > a {
    display: inline-flex;
    align-items: center;
    color: ${({ theme }) => theme.colors.primary};
    font-weight: 600;
    text-decoration: none;
  }
`

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Heading = styled.h2`
  margin: 0 0 10px;
  font-size: 18px;
  color: ${({ theme }) => theme.colors.primaryStrong};
`

const Tabs = styled.div`
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
  padding-bottom: 4px;
  overflow-x: auto;
`

const Tab = styled.button<{ $active: boolean }>`
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  cursor: pointer;
  ${({ $active, theme }) =>
    $active &&
    css`
      border-color: ${theme.colors.primary};
      background: ${theme.colors.primary};
      color: ${theme.colors.onPrimary};
    `}
`

const Versus = styled.span<{ $value: number }>`
  font-variant-numeric: tabular-nums;
  color: ${({ $value, theme }) => ($value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger)};
  button[aria-selected='true'] > & {
    color: inherit;
  }
`

const errorText = (e: unknown, message: ReturnType<typeof usePreferences>['message']) =>
  e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)

export function ChallengeBoardPage() {
  const { challengeId = '', seq: seqParam = '' } = useParams()
  const seq = Number(seqParam)
  const [params, setParams] = useSearchParams()
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const [challenge, setChallenge] = useState<ChallengeView | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [traveller, setTraveller] = useState<{ boardId: string; traveller: Traveller | null } | null>(null)
  const [record, setRecord] = useState<{ id: string; record?: BoardRecord; error?: string } | null>(null)

  useEffect(() => {
    let live = true
    api
      .challenge(challengeId)
      .then((r) => live && setChallenge(r.challenge))
      .catch((e) => {
        if (!live) return
        if (e instanceof ApiError && e.status === 404) setChallenge(null)
        else setError(errorText(e, message))
      })
    return () => {
      live = false
    }
  }, [challengeId, message])

  const c = challenge
  const board = c?.travellers?.find((x) => x.seq === seq)
  const order = c && user ? resultOrder(c, user.id) : []
  const entries = [...(board?.entries ?? [])].sort((a, b) => order.indexOf(a.userId) - order.indexOf(b.userId))
  const mine = entries.find((e) => e.userId === user?.id)
  const chosen = entries.find((e) => e.userId === params.get('p')) ?? mine ?? entries[0]
  const anyBoard = entries[0]?.boardId
  const chosenId = chosen?.boardId

  // Any record of the board will do: the server answers with the traveller this member may see
  useEffect(() => {
    if (!anyBoard) return
    let live = true
    api
      .traveller(anyBoard)
      .then((r) => live && setTraveller({ boardId: anyBoard, traveller: r.traveller }))
      .catch((e) => live && setError(errorText(e, message)))
    return () => {
      live = false
    }
  }, [anyBoard, message])

  useEffect(() => {
    if (!chosenId) return
    let live = true
    api
      .record(chosenId)
      .then((r) => live && setRecord({ id: chosenId, record: r.record }))
      .catch((e) => live && setRecord({ id: chosenId, error: errorText(e, message) }))
    return () => {
      live = false
    }
  }, [chosenId, message])

  const back = (
    <Back back to={`/challenges/${challengeId}`}>
      {t.backToChallenge}
    </Back>
  )
  if (c === null)
    return (
      <PageMain>
        <Back back to="/challenges">
          {t.allChallenges}
        </Back>
        <Card>
          <Muted>{t.challengeNotFound}</Muted>
        </Card>
      </PageMain>
    )
  if (!c || !user)
    return <PageMain>{error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}</PageMain>
  if (!board || !chosen)
    return (
      <PageMain>
        {back}
        <Card>
          <Muted>{t.boardNotShown}</Muted>
        </Card>
      </PageMain>
    )

  const seqs = (c.travellers ?? []).map((x) => x.seq)
  const at = seqs.indexOf(seq)
  const prev = seqs[at - 1]
  const next = seqs[at + 1]
  const scoring = c.settings.scoring
  const versus = new Map(
    (travellerScores(c)[user.id] ? headToHead(scoring, travellerScores(c), user.id, travellerRulings(c)) : []).map((v) => [
      v.opponent,
      v.boards[seq - 1],
    ]),
  )
  const nameOf = (id: string) => (id === user.id ? t.you : participantName(t, playerOf(c, id)))
  const shown = traveller && traveller.boardId === anyBoard ? traveller.traveller : null
  const loadedRecord = record?.id === chosen.boardId ? record : null
  const choose = (userId: string) => setParams({ p: userId }, { replace: true })

  return (
    <PageMain>
      {back}
      <PageTitle>
        {challengeTitle(t, c)} · {t.boardNo(board.boardNo)}
      </PageTitle>
      <Nav aria-label={t.boardResultsTitle}>
        <Muted as="span">
          {t.dealerVul(t.seatNames[dealerOf(board.boardNo)], t.vulNames[vulnerabilityOf(board.boardNo)])}
        </Muted>
        {prev !== undefined && (
          <Link to={`/challenges/${c.id}/boards/${prev}`}>
            <ChevronLeft size={16} aria-hidden />
            {t.prevBoard}
          </Link>
        )}
        {next !== undefined && (
          <Link to={`/challenges/${c.id}/boards/${next}`}>
            {t.nextBoard}
            <ChevronRight size={16} aria-hidden />
          </Link>
        )}
      </Nav>
      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-labelledby="traveller-title">
        <h2 id="traveller-title">{t.travellerTitle}</h2>
        {shown ? (
          <TravellerTable
            traveller={shown}
            current={chosen.boardId}
            compareFrom={mine?.boardId ?? chosen.boardId}
            viewerId={user.id}
          />
        ) : (
          !error && <Muted>{t.loading}</Muted>
        )}
      </Section>

      {/* Not in a card: the hand diagram needs the page's full width on a phone */}
      <section aria-labelledby="played-by-title">
        <Heading id="played-by-title">{t.boardPlayedBy}</Heading>
        <Tabs role="tablist" aria-labelledby="played-by-title">
          {entries.map((e) => {
            const value = e.userId === user.id ? null : versus.get(e.userId)
            return (
              <Tab
                key={e.boardId}
                type="button"
                role="tab"
                aria-selected={e.boardId === chosen.boardId}
                $active={e.boardId === chosen.boardId}
                onClick={() => choose(e.userId)}
              >
                {nameOf(e.userId)}
                {value !== null && value !== undefined && (
                  <Versus $value={tone(value, scoring)}>{formatScore(value, scoring)}</Versus>
                )}
              </Tab>
            )
          })}
        </Tabs>
        <div role="tabpanel" aria-label={nameOf(chosen.userId)}>
          {loadedRecord?.record ? (
            <BoardRecordView key={loadedRecord.record.id} record={loadedRecord.record} embedded titled={false} />
          ) : loadedRecord?.error ? (
            <ErrorText role="alert">{loadedRecord.error}</ErrorText>
          ) : (
            <Muted>{t.loading}</Muted>
          )}
        </div>
      </section>
    </PageMain>
  )
}
