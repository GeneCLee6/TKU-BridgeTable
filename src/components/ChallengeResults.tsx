import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { dealerOf, vulnerabilityOf } from '../../shared/board.ts'
import { rankLabel, rankOf, suitOf } from '../../shared/cards.ts'
import { headToHead, headToHeadTotal, type ChallengeScoring } from '../../shared/challenge-scoring.ts'
import type { ChallengeTravellerEntry, ChallengeView } from '../../shared/challenge.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { cardName } from '../lib/cards.ts'
import { formatScore, participantName, playerOf, resultOrder, tone, travellerScores } from '../lib/challenges.ts'
import { signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { ContractLabel, SuitSymbol } from './Suit.tsx'
import { Card, Muted } from './ui.tsx'

/**
 * A challenge's results board by board, as BBO shows a challenge's results (社長, 2026-10-25): how
 * the member did against each other participant over the boards both played, then every board with
 * one compact row per player (contract and declarer, lead, result, N-S score, the board's result in
 * the challenge's scoring) and the member's result against each of them on that board. A board
 * opens its own page with the deal and everyone's auction and play (`ChallengeBoardPage`).
 * Everything comes from the `ChallengeView` the server sent, which already follows §4: someone still
 * playing has no travellers, so this shows nothing to them.
 */

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Boards = styled.div`
  display: grid;
  gap: 12px;
  margin-top: 12px;
`

const Board = styled.article`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  overflow: hidden;
`

/**
 * The board's title bar is one link (社長 2026-10-27: no second 「看這一副」 beside it): the board
 * number's link stretches over the whole bar, so clicking anywhere on it opens the board, and the
 * chevron on the right says so
 */
const BoardHead = styled.header`
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  padding: 8px 10px;
  background: ${({ theme }) => theme.colors.surfaceAlt};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  transition: background 0.12s;

  &:hover {
    background: ${({ theme }) => theme.colors.accentSoft};
  }
  &:has(a:focus-visible) {
    outline: 2px solid ${({ theme }) => theme.colors.focus};
    outline-offset: -2px;
  }

  & > h3 {
    margin: 0;
    font-size: 16px;
  }
  & > h3 > a {
    color: ${({ theme }) => theme.colors.primary};
    text-decoration: none;
  }
  & > h3 > a:focus-visible {
    outline: none;
  }
  & > h3 > a::after {
    content: '';
    position: absolute;
    inset: 0;
  }
  & > svg {
    flex: none;
    margin-left: auto;
    color: ${({ theme }) => theme.colors.primary};
  }
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;
  white-space: nowrap;

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  tr:last-child > td, tr:last-child > th {
    border-bottom: 0;
  }
  thead th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  tbody th {
    font-weight: 600;
  }
  tr[aria-current='true'] > * {
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
  }
  tr[data-total] > * {
    border-top: 2px solid ${({ theme }) => theme.colors.border};
    font-weight: 700;
  }

  ${mobile} {
    font-size: 14px;

    th, td {
      padding: 6px 5px;
    }
    [data-wide] {
      display: none;
    }
  }
`

const Name = styled.th`
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;

  & > a { color: inherit; }

  ${mobile} {
    max-width: 72px;
  }
`

const Num = styled.td<{ $value?: number }>`
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

const NumHead = styled.th`
  text-align: right !important;
`

export function ChallengeResults({ challenge: c, userId }: { challenge: ChallengeView; userId: string }) {
  const { t } = usePreferences()
  if (!c.travellers?.length) return null
  const scoring = c.settings.scoring
  const scores = travellerScores(c)
  const versus = scores[userId] ? headToHead(scoring, scores, userId) : []
  const versusOf = new Map(versus.map((v) => [v.opponent, v]))
  const order = resultOrder(c, userId)
  const place = (id: string) => order.indexOf(id)
  const points = new Map(c.standings?.ranked.map((r) => [r.userId, r.boards]) ?? [])
  const unit = c.standings?.scoring ?? scoring
  const withPoints = [...points.values()].some((b) => b !== undefined)
  const nameOf = (id: string) => (id === userId ? t.you : participantName(t, playerOf(c, id)))
  const all = headToHeadTotal(scoring, versus)
  // Cross-IMP challenges compare each pair in plain IMPs
  const pairUnit = scoring === 'crossImp' ? 'imp' : scoring
  const compared = versus.filter((v) => v.compared > 0).sort((a, b) => place(a.opponent) - place(b.opponent))

  return (
    <>
      {compared.length > 0 && (
        <Section aria-labelledby="versus-title">
          <h2 id="versus-title">{t.versusTitle}</h2>
          <Muted>{t.versusNote[scoring]}</Muted>
          <Scroll>
            <Table>
              <thead>
                <tr>
                  <th scope="col">{t.memberCol}</th>
                  <td data-wide />
                  <NumHead scope="col">{t.scorings[pairUnit]}</NumHead>
                </tr>
              </thead>
              <tbody>
                {compared.map((v) => (
                  <tr key={v.opponent}>
                    <Name scope="row">{nameOf(v.opponent)}</Name>
                    <td data-wide>
                      <Muted as="span">{t.versusCompared(v.compared)}</Muted>
                    </td>
                    <Num $value={tone(v.total!, scoring)}>{formatScore(v.total!, scoring)}</Num>
                  </tr>
                ))}
                {compared.length > 1 && all !== null && (
                  <tr data-total="">
                    <Name scope="row">{t.versusAll}</Name>
                    <td data-wide />
                    <Num $value={tone(all, scoring)}>{formatScore(all, scoring)}</Num>
                  </tr>
                )}
              </tbody>
            </Table>
          </Scroll>
        </Section>
      )}

      <Section aria-labelledby="boards-title">
        <h2 id="boards-title">{t.boardResultsTitle}</h2>
        <Muted>{t.boardResultsHint}</Muted>
        <Boards>
          {c.travellers.map((x) => {
            const entries = [...x.entries].sort((a, b) => place(a.userId) - place(b.userId))
            const mine = scores[userId]?.[x.seq - 1] ?? null
            const to = `/challenges/${c.id}/boards/${x.seq}`
            const headId = `board-${x.seq}`
            return (
              <Board key={x.seq} aria-labelledby={headId}>
                <BoardHead>
                  <h3 id={headId}>
                    <Link to={to}>{t.boardNo(x.boardNo)}</Link>
                  </h3>
                  <Muted as="span">
                    {t.dealerVul(t.seatNames[dealerOf(x.boardNo)], t.vulNames[vulnerabilityOf(x.boardNo)])}
                  </Muted>
                  <ChevronRight size={18} aria-hidden />
                </BoardHead>
                <Scroll>
                  <Table>
                    <thead>
                      <tr>
                        <th scope="col">{t.memberCol}</th>
                        <th scope="col">{t.contract}</th>
                        <th scope="col">{t.openingLead}</th>
                        <th scope="col">{t.result}</th>
                        <NumHead scope="col">{t.nsCol}</NumHead>
                        {withPoints && (
                          <NumHead scope="col" data-wide>
                            {t.scorings[unit]}
                          </NumHead>
                        )}
                        {mine !== null && <NumHead scope="col">{t.versusCol}</NumHead>}
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <ResultRow
                          key={e.boardId}
                          entry={e}
                          name={nameOf(e.userId)}
                          to={`${to}?p=${encodeURIComponent(e.userId)}`}
                          me={e.userId === userId}
                          points={withPoints ? (points.get(e.userId)?.[x.seq - 1] ?? null) : undefined}
                          unit={unit}
                          versus={mine === null ? undefined : (versusOf.get(e.userId)?.boards[x.seq - 1] ?? null)}
                          scoring={scoring}
                        />
                      ))}
                    </tbody>
                  </Table>
                </Scroll>
              </Board>
            )
          })}
        </Boards>
      </Section>
    </>
  )
}

/** One player's result on a board; `points` and `versus` are left out when the column is not shown */
function ResultRow({
  entry: e,
  name,
  to,
  me,
  points,
  unit,
  versus,
  scoring,
}: {
  entry: ChallengeTravellerEntry
  name: string
  to: string
  me: boolean
  points?: number | null
  /** What `points` is in: the standings' scoring */
  unit: ChallengeScoring
  versus?: number | null
  /** What `versus` is in: the challenge's scoring */
  scoring: ChallengeScoring
}) {
  const { t } = usePreferences()
  return (
    <tr aria-current={me ? 'true' : undefined}>
      <Name scope="row">
        <Link to={to}>{name}</Link>
      </Name>
      <td>
        <ContractLabel contract={e.contract} />
      </td>
      <td aria-label={e.lead ? cardName(e.lead, t) : undefined}>
        {e.lead ? (
          <>
            <SuitSymbol suit={suitOf(e.lead)} />
            {rankLabel(rankOf(e.lead))}
          </>
        ) : (
          '—'
        )}
      </td>
      <td>{e.contract && e.declarerTricks !== null ? resultLabel(e.contract, e.declarerTricks) : '—'}</td>
      <Num $value={e.scoreNS}>{signed(e.scoreNS)}</Num>
      {points !== undefined && (
        <Num data-wide $value={points === null ? undefined : tone(points, unit)}>
          {points === null ? '—' : formatScore(points, unit)}
        </Num>
      )}
      {versus !== undefined &&
        (versus === null || me ? (
          <Num>—</Num>
        ) : (
          <Num $value={tone(versus, scoring)}>{formatScore(versus, scoring)}</Num>
        ))}
    </tr>
  )
}
