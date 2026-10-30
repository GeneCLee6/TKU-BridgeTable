import { Columns2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { rankLabel, rankOf, suitOf } from '../../shared/cards.ts'
import { resultLabel } from '../../shared/scoring.ts'
import type { Traveller, TravellerEntry } from '../../shared/traveller.ts'
import { formatScore, tone } from '../lib/challenges.ts'
import { cardName } from '../lib/cards.ts'
import { signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'
import { RulingTag } from './RulingTag.tsx'
import { ContractLabel, SuitSymbol } from './Suit.tsx'
import { Button } from './ui.tsx'

/**
 * A traveller (`e4-t32`, AC-4.12): everyone's result on one board, side by side: who played it,
 * the contract, the declarer, the opening lead, the result, the N-S score and, when the event is
 * ranked, the board's result in its scoring. The server already left out what the viewer may not
 * see (`/api/history/:id/traveller`, ARCHITECTURE.md §4). Each other row can be replayed beside
 * `compareFrom` (`e4-t33`).
 */

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  border-collapse: collapse;
  width: 100%;
  font-size: 15px;
  white-space: nowrap;

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  tr[aria-current='true'] td {
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
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

export function TravellerTable({
  traveller,
  current,
  compareFrom,
  viewerId,
}: {
  traveller: Traveller
  /** The board on the page, highlighted */
  current?: string
  /** The board the others are compared with (the viewer's own, or the one on the page) */
  compareFrom?: string
  viewerId?: string
}) {
  const { t } = usePreferences()
  const ranked = traveller.entries.some((e) => e.points !== undefined)
  const who = (e: TravellerEntry) => (e.userId === viewerId ? t.you : (e.user?.username ?? t.deletedMember))

  return (
    <Scroll>
      <Table>
        <thead>
          <tr>
            <th scope="col">{t.memberCol}</th>
            <th scope="col">{t.contract}</th>
            <th scope="col">{t.declarer}</th>
            <th scope="col">{t.openingLead}</th>
            <th scope="col">{t.result}</th>
            <NumHead scope="col">{t.scoreNS}</NumHead>
            {ranked && <NumHead scope="col">{t.scorings[traveller.scoring]}</NumHead>}
            {compareFrom && <th scope="col" aria-label={t.compareTitle} />}
          </tr>
        </thead>
        <tbody>
          {traveller.entries.map((e) => (
            <tr key={e.boardId} aria-current={e.boardId === current ? 'true' : undefined}>
              <td>{e.boardId === current ? who(e) : <Link to={`/history/${e.boardId}`}>{who(e)}</Link>}</td>
              <td>
                <ContractLabel contract={e.contract} />
              </td>
              <td>{e.declarer ? playerName(t, e.declarer) : '—'}</td>
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
              <Num $value={e.scoreNS}>
                {signed(e.scoreNS)}
                {e.ruling && <RulingTag ruling={e.ruling} />}
              </Num>
              {ranked && (
                <Num $value={e.points === undefined ? undefined : tone(e.points, traveller.scoring)}>
                  {e.points === undefined ? '—' : formatScore(e.points, traveller.scoring)}
                </Num>
              )}
              {compareFrom && (
                <td>
                  {e.boardId !== compareFrom && (
                    <Button as={Link} to={`/history/${compareFrom}/vs/${e.boardId}`} $small $variant="ghost">
                      <Columns2 size={16} aria-hidden />
                      {t.compareWith(who(e))}
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
    </Scroll>
  )
}
