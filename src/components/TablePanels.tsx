import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { signed } from '../lib/format.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { ContractLabel } from './Suit.tsx'

/** Panels in the middle of the felt: claim and undo prompts, the result */

export const FeltPanel = styled.div`
  display: grid;
  justify-items: center;
  gap: 10px;
  width: min(100%, 380px);
  padding: 14px 18px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35);
  text-align: center;
  font-size: 16px;
`

export const FeltButton = styled.button<{ $tone?: 'go' | 'stop' | 'plain' }>`
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 6px;
  background: ${({ $tone, theme }) =>
    $tone === 'go' ? theme.table.bidPass : $tone === 'stop' ? theme.table.bidDouble : theme.table.bidRedouble};
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  &:disabled { opacity: 0.55; }
`

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
`

const Big = styled.div`
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: 26px;
  font-weight: 800;
`

const Score = styled.div<{ $positive: boolean }>`
  font-size: 19px;
  font-weight: 800;
  color: ${({ $positive, theme }) => ($positive ? theme.table.bidPass : theme.table.bidDouble)};
`

const SmallLink = styled(Link)`
  color: ${({ theme }) => theme.table.bidRedouble};
  font-size: 14px;
`

export function ResultPanel({
  board,
  seated,
  ready,
  people,
  onReady,
  declarerName,
}: {
  board: BoardView
  seated: Seat | null
  ready: Seat[]
  /** Seats held by people, who each press "next board" */
  people: Seat[]
  onReady: () => void
  declarerName?: string
}) {
  const t = useT()
  const result = board.result!
  const contract = board.contract
  const iAmReady = seated !== null && ready.includes(seated)
  return (
    <FeltPanel role="status" aria-label={t.result}>
      <Big>
        <ContractLabel contract={contract} onCard />
      </Big>
      {contract && (
        <div>
          {declarerName ?? seatLetter[contract.declarer]} · {result.declarerTricks} {t.tricks} ·{' '}
          {t.made(resultLabel(contract, result.declarerTricks))}
          {result.claimed && t.claimed}
        </div>
      )}
      <Score $positive={result.scoreNS >= 0}>
        {t.ns} {signed(result.scoreNS)}
      </Score>
      {seated && (
        <FeltButton type="button" $tone="go" disabled={iAmReady} onClick={onReady}>
          {iAmReady ? t.waitingOthers : t.nextBoard}
        </FeltButton>
      )}
      <div>{t.readyCount(people.filter((s) => ready.includes(s)).length, people.length)}</div>
      {board.recordId && (
        <SmallLink to={`/history/${board.recordId}`} target="_blank" rel="noopener">
          {t.viewRecord}
        </SmallLink>
      )}
    </FeltPanel>
  )
}

export function ClaimPicker({
  remaining,
  onClaim,
  onCancel,
}: {
  remaining: number
  onClaim: (tricks: number) => void
  onCancel: () => void
}) {
  const t = useT()
  return (
    <FeltPanel>
      <div>{t.claimTitle}</div>
      <Buttons>
        {Array.from({ length: remaining + 1 }, (_, n) => (
          <FeltButton key={n} type="button" $tone="plain" onClick={() => onClaim(n)} aria-label={t.claimTricks(n)}>
            {n}
          </FeltButton>
        ))}
      </Buttons>
      <FeltButton type="button" $tone="stop" onClick={onCancel}>
        {t.cancel}
      </FeltButton>
    </FeltPanel>
  )
}

/** A question with yes/no buttons (claim and undo requests), or a waiting message */
export function Prompt({
  text,
  detail,
  yes,
  no,
  onAnswer,
}: {
  text: string
  detail?: string
  yes?: string
  no?: string
  onAnswer?: (accept: boolean) => void
}) {
  return (
    <FeltPanel role="alert">
      <div>{text}</div>
      {detail && <div>{detail}</div>}
      {onAnswer && (
        <Buttons>
          <FeltButton type="button" $tone="go" onClick={() => onAnswer(true)}>
            {yes}
          </FeltButton>
          <FeltButton type="button" $tone="stop" onClick={() => onAnswer(false)}>
            {no}
          </FeltButton>
        </Buttons>
      )}
    </FeltPanel>
  )
}
