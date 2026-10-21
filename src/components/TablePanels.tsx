import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { signed } from '../lib/format.ts'
import { seatLetter, strings } from '../strings.ts'
import { ContractLabel } from './Suit.tsx'

/** Panels that appear in the middle of the felt: claim and undo prompts, the result of a board */

export const FeltPanel = styled.div`
  display: grid;
  justify-items: center;
  gap: 8px;
  width: min(100%, 320px);
  padding: 12px 14px;
  border-radius: 8px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
  text-align: center;
  font-size: 15px;
`

export const FeltButton = styled.button<{ $tone?: 'go' | 'stop' | 'plain' }>`
  min-height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 5px;
  background: ${({ $tone, theme }) =>
    $tone === 'go' ? theme.table.bidPass : $tone === 'stop' ? theme.table.bidDouble : theme.table.bidRedouble};
  color: #ffffff;
  font-weight: 600;
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
  font-size: 22px;
  font-weight: 700;
`

const Score = styled.div<{ $positive: boolean }>`
  font-size: 17px;
  font-weight: 700;
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
  onReady,
  declarerName,
}: {
  board: BoardView
  seated: Seat | null
  ready: Seat[]
  onReady: () => void
  declarerName?: string
}) {
  const result = board.result!
  const contract = board.contract
  const iAmReady = seated !== null && ready.includes(seated)
  return (
    <FeltPanel role="status" aria-label={strings.result}>
      <Big>
        <ContractLabel contract={contract} onCard />
      </Big>
      {contract && (
        <div>
          {declarerName ?? seatLetter[contract.declarer]} · {result.declarerTricks} {strings.tricks}
          {' · '}
          {strings.made(resultLabel(contract, result.declarerTricks))}
          {result.claimed && strings.claimed}
        </div>
      )}
      <Score $positive={result.scoreNS >= 0}>
        {strings.ns} {signed(result.scoreNS)}
      </Score>
      <Buttons>
        {seated && (
          <FeltButton type="button" $tone="go" disabled={iAmReady} onClick={onReady}>
            {iAmReady ? strings.waitingOthers : strings.nextBoard}
          </FeltButton>
        )}
      </Buttons>
      <div>{strings.readyCount(ready.length)}</div>
      {board.recordId && (
        <SmallLink to={`/history/${board.recordId}`} target="_blank" rel="noopener">
          {strings.viewRecord}
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
  return (
    <FeltPanel>
      <div>{strings.claimTitle}</div>
      <Buttons>
        {Array.from({ length: remaining + 1 }, (_, n) => (
          <FeltButton key={n} type="button" $tone="plain" onClick={() => onClaim(n)} aria-label={strings.claimTricks(n)}>
            {n}
          </FeltButton>
        ))}
      </Buttons>
      <FeltButton type="button" $tone="stop" onClick={onCancel}>
        {strings.cancel}
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
