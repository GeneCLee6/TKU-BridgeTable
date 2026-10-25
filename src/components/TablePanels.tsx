import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import styled, { css, keyframes } from 'styled-components'
import type { BoardView } from '../../shared/protocol.ts'
import { signed } from '../lib/format.ts'
import { typingIn } from '../lib/useCardChoice.ts'
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

export const FeltButton = styled.button<{ $tone?: 'go' | 'stop' | 'plain'; $selected?: boolean }>`
  min-height: 38px;
  padding: 0 16px;
  border: 0;
  border-radius: 6px;
  background: ${({ $tone, theme }) =>
    $tone === 'go' ? theme.table.bidPass : $tone === 'stop' ? theme.table.bidDouble : theme.table.bidRedouble};
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  ${({ $selected, theme }) =>
    $selected &&
    css`
      background: ${theme.table.bidSelected};
      box-shadow: inset 0 0 0 2px ${theme.table.panelText};
      color: ${theme.table.bidButtonText};
    `}
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

/**
 * Choosing how many more tricks to claim. A number only chooses (and is highlighted); the claim is
 * sent from 確定, so a slip of the finger does not claim. Enter confirms, Escape cancels.
 */
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
  const [chosen, setChosen] = useState<number | null>(null)

  // Captured on window so the card keys (Enter plays a lifted card, Escape drops it) do not also act
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || typingIn(e.target)) return
      if (e.key === 'Enter') {
        // Also keeps a focused button from being clicked by the same key
        e.preventDefault()
        e.stopPropagation()
        if (chosen !== null) onClaim(chosen)
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [chosen, onClaim, onCancel])

  return (
    <FeltPanel role="group" aria-label={t.claimTitle}>
      <div>{t.claimTitle}</div>
      <Buttons>
        {Array.from({ length: remaining + 1 }, (_, n) => (
          <FeltButton
            key={n}
            type="button"
            $tone="plain"
            $selected={chosen === n}
            aria-pressed={chosen === n}
            onClick={() => setChosen(n)}
            aria-label={t.claimTricks(n)}
          >
            {n}
          </FeltButton>
        ))}
      </Buttons>
      <div>{chosen === null ? t.claimPick : t.claimChosen(chosen)}</div>
      <Buttons>
        <FeltButton
          type="button"
          $tone="go"
          disabled={chosen === null}
          aria-keyshortcuts="Enter"
          onClick={() => chosen !== null && onClaim(chosen)}
        >
          {t.confirm}
        </FeltButton>
        <FeltButton type="button" $tone="stop" aria-keyshortcuts="Escape" onClick={onCancel}>
          {t.cancel}
        </FeltButton>
      </Buttons>
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
