import { useState } from 'react'
import styled, { css } from 'styled-components'
import { LEVELS, STRAINS, type Call } from '../../shared/auction.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { strings } from '../strings.ts'
import { SuitSymbol } from './Suit.tsx'

/**
 * BBO's bidding box: pick a level (1–7), then a strain, and the bid is made. Pass, X and XX are
 * green, red and blue; Alert attaches an explanation that only the opponents see.
 */

const Box = styled.div`
  display: grid;
  gap: 6px;
  width: min(100%, 340px);
  padding: 8px;
  border-radius: 8px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
`

const Grid = styled.div<{ $columns: number }>`
  display: grid;
  grid-template-columns: repeat(${({ $columns }) => $columns}, minmax(0, 1fr));
  gap: 4px;
`

const Key = styled.button<{ $tone?: 'pass' | 'double' | 'redouble' | 'alert'; $selected?: boolean }>`
  min-height: 38px;
  padding: 0 2px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 5px;
  background: ${({ theme }) => theme.table.bidButton};
  color: ${({ theme }) => theme.table.bidButtonText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: 18px;
  font-weight: 700;

  ${({ $tone, theme }) => {
    if (!$tone) return ''
    const bg = {
      pass: theme.table.bidPass,
      double: theme.table.bidDouble,
      redouble: theme.table.bidRedouble,
      alert: theme.table.bidAlert,
    }[$tone]
    return css`
      background: ${bg};
      border-color: ${bg};
      color: ${$tone === 'alert' ? theme.table.bidButtonText : '#ffffff'};
      font-size: 15px;
    `
  }}
  ${({ $selected, theme }) =>
    $selected &&
    css`
      background: ${theme.table.bidSelected};
      border-color: ${theme.table.panelText};
    `}

  &:disabled {
    background: ${({ theme }) => theme.table.bidDisabled};
    border-color: ${({ theme }) => theme.table.bidDisabled};
    color: rgba(0, 0, 0, 0.35);
    opacity: 0.7;
  }
`

const AlertInput = styled.input`
  width: 100%;
  min-height: 34px;
  padding: 4px 8px;
  border: 1px solid ${({ theme }) => theme.table.bidAlert};
  border-radius: 5px;
  background: #fffbe6;
  color: ${({ theme }) => theme.table.panelText};
  font-size: 14px;
`

export function BiddingBox({ legal, onCall }: { legal: Call[]; onCall: (call: Call, alert?: string) => void }) {
  const [level, setLevel] = useState<number | null>(null)
  const [alerting, setAlerting] = useState(false)
  const [explanation, setExplanation] = useState('')
  const allowed = new Set(legal)

  const call = (value: Call) => {
    onCall(value, alerting ? explanation.trim() : undefined)
    setLevel(null)
    setAlerting(false)
    setExplanation('')
  }

  return (
    <Box role="group" aria-label={strings.biddingBox}>
      <Grid $columns={7}>
        {LEVELS.map((n) => (
          <Key
            key={n}
            type="button"
            $selected={level === n}
            disabled={!STRAINS.some((s) => allowed.has(`${n}${s}`))}
            onClick={() => setLevel(level === n ? null : n)}
            aria-pressed={level === n}
          >
            {n}
          </Key>
        ))}
      </Grid>
      <Grid $columns={5}>
        {STRAINS.map((strain) => (
          <Key
            key={strain}
            type="button"
            disabled={level === null || !allowed.has(`${level}${strain}`)}
            onClick={() => level !== null && call(`${level}${strain}`)}
          >
            <SuitSymbol suit={strain} onCard />
          </Key>
        ))}
      </Grid>
      <Grid $columns={4}>
        <Key type="button" $tone="pass" disabled={!allowed.has('P')} onClick={() => call('P')}>
          {strings.pass}
        </Key>
        <Key type="button" $tone="double" disabled={!allowed.has('X')} onClick={() => call('X')}>
          {strings.double}
        </Key>
        <Key type="button" $tone="redouble" disabled={!allowed.has('XX')} onClick={() => call('XX')}>
          {strings.redouble}
        </Key>
        <Key
          type="button"
          $tone="alert"
          $selected={alerting}
          aria-pressed={alerting}
          onClick={() => setAlerting(!alerting)}
        >
          {strings.alert}
        </Key>
      </Grid>
      {alerting && (
        <AlertInput
          autoFocus
          value={explanation}
          maxLength={LIMITS.alertMax}
          onChange={(e) => setExplanation(e.target.value)}
          placeholder={strings.alertExplain}
          aria-label={strings.alertExplain}
        />
      )}
    </Box>
  )
}
