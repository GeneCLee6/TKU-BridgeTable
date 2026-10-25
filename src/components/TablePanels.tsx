import { Link } from 'react-router-dom'
import styled, { keyframes } from 'styled-components'
import type { BoardView, PublicUser } from '../../shared/protocol.ts'
import { signed } from '../lib/format.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { FavoriteButton } from './FavoriteButton.tsx'
import { ContractResult } from './Suit.tsx'

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

const RING = 26
const CIRCUMFERENCE = 2 * Math.PI * RING

const drain = keyframes`
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: ${CIRCUMFERENCE}; }
`

const pop = keyframes`
  from { transform: scale(1.35); opacity: 0.2; }
  to { transform: scale(1); opacity: 1; }
`

const Ring = styled.div`
  position: relative;
  width: 64px;
  height: 64px;

  & > svg { position: absolute; inset: 0; transform: rotate(-90deg); }
  & circle { fill: none; stroke-width: 6; }
  & circle:first-child { stroke: ${({ theme }) => theme.table.ringTrack}; }
  & circle:last-child {
    stroke: ${({ theme }) => theme.table.ring};
    stroke-linecap: round;
    stroke-dasharray: ${CIRCUMFERENCE};
    animation: ${drain} 1s linear both;
  }
  & > span {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: ${({ theme }) => theme.fonts.cards};
    font-size: 26px;
    font-weight: 800;
    animation: ${pop} 0.35s ease-out both;
  }
`

/** BBO's countdown before the next deal: the number in a ring that empties each second */
export function Countdown({ seconds }: { seconds: number }) {
  const t = useT()
  return (
    // Keyed by the second, so the ring and the number start again each time
    <Ring key={seconds} role="timer" aria-label={t.dealingIn(seconds)}>
      <svg viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r={RING} />
        <circle cx="32" cy="32" r={RING} />
      </svg>
      <span aria-hidden>{seconds}</span>
    </Ring>
  )
}

/**
 * The result of the board just finished, in bridge shorthand whatever the language (2♦ N +5,
 * --), with the countdown to the next deal while it runs
 */
export function ResultPanel({ board, declarerName, seconds }: { board: BoardView; declarerName?: string; seconds: number | null }) {
  const t = useT()
  const result = board.result!
  const contract = board.contract
  return (
    <FeltPanel role="status" aria-label={t.result}>
      <Big>
        <ContractResult contract={contract} tricks={result.declarerTricks} onCard />
      </Big>
      {contract && (
        <div>
          {declarerName ?? seatLetter[contract.declarer]}
          {result.claimed && t.claimed}
        </div>
      )}
      <Score $positive={result.scoreNS >= 0}>NS {signed(result.scoreNS)}</Score>
      {seconds !== null && <Countdown seconds={seconds} />}
      {board.recordId && (
        <div>
          <FavoriteButton boardId={board.recordId} onFelt />
          <SmallLink to={`/history/${board.recordId}`} target="_blank" rel="noopener">
            {t.viewRecord}
          </SmallLink>
        </div>
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

/** The host's requests to join (a request table), at the top of the felt; clicks stay in it */
const RequestsBox = styled(FeltPanel)`
  position: absolute;
  top: 8px;
  left: 50%;
  z-index: 30;
  width: min(calc(100% - 32px), 380px);
  gap: 8px;
  transform: translateX(-50%);
  font-size: 14px;
`

const RequestRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
`

/** Members waiting for the host's answer, each with 同意 / 拒絕; nothing when there are none */
export function JoinRequests({
  requests,
  onAnswer,
}: {
  requests: { user: PublicUser; at: number }[]
  onAnswer: (userId: string, accept: boolean) => void
}) {
  const t = useT()
  if (!requests.length) return null
  return (
    <RequestsBox role="region" aria-label={t.joinRequests} onClick={(event) => event.stopPropagation()}>
      <strong>{t.joinRequests}</strong>
      {requests.map(({ user }) => (
        <RequestRow key={user.id}>
          <span>{t.requestFrom(user.username)}</span>
          <FeltButton type="button" $tone="go" onClick={() => onAnswer(user.id, true)}>
            {t.approveRequest}
          </FeltButton>
          <FeltButton type="button" $tone="stop" onClick={() => onAnswer(user.id, false)}>
            {t.declineRequest}
          </FeltButton>
        </RequestRow>
      ))}
    </RequestsBox>
  )
}
