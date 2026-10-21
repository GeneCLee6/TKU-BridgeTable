import { useState } from 'react'
import styled, { css } from 'styled-components'
import { LEVELS, STRAINS, type Call } from '../../shared/auction.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { SuitSymbol } from './Suit.tsx'

/**
 * BBO's bidding box: pick a level (1–7), then a strain, and the bid is made. Pass, X and XX are
 * green, red and blue; Alert attaches an explanation that only the opponents see. `size` scales
 * the keys with the cards at the table.
 */

const Box = styled.div<{ $size: number }>`
  display: grid;
  gap: ${({ $size }) => Math.round($size * 0.1)}px;
  width: min(100%, ${({ $size }) => Math.round($size * 6.4)}px);
  padding: ${({ $size }) => Math.round($size * 0.14)}px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
`

const Grid = styled.div<{ $columns: number; $size: number }>`
  display: grid;
  grid-template-columns: repeat(${({ $columns }) => $columns}, minmax(0, 1fr));
  gap: ${({ $size }) => Math.round($size * 0.08)}px;
`

const Key = styled.button<{ $tone?: 'pass' | 'double' | 'redouble' | 'alert'; $selected?: boolean; $size: number }>`
  min-height: ${({ $size }) => Math.max(40, Math.round($size * 0.66))}px;
  padding: 0 2px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 6px;
  background: ${({ theme }) => theme.table.bidButton};
  color: ${({ theme }) => theme.table.bidButtonText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: ${({ $size }) => Math.max(18, Math.round($size * 0.36))}px;
  font-weight: 700;

  ${({ $tone, theme, $size }) => {
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
      font-size: ${Math.max(16, Math.round($size * 0.28))}px;
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
  min-height: 38px;
  padding: 4px 8px;
  border: 1px solid ${({ theme }) => theme.table.bidAlert};
  border-radius: 6px;
  background: #fffbe6;
  color: ${({ theme }) => theme.table.panelText};
  font-size: 15px;
`

export function BiddingBox({
  legal,
  onCall,
  size = 60,
}: {
  legal: Call[]
  onCall: (call: Call, alert?: string) => void
  size?: number
}) {
  const t = useT()
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
    <Box $size={size} role="group" aria-label={t.biddingBox}>
      <Grid $columns={7} $size={size}>
        {LEVELS.map((n) => (
          <Key
            key={n}
            type="button"
            $size={size}
            $selected={level === n}
            disabled={!STRAINS.some((s) => allowed.has(`${n}${s}`))}
            onClick={() => setLevel(level === n ? null : n)}
            aria-pressed={level === n}
          >
            {n}
          </Key>
        ))}
      </Grid>
      <Grid $columns={5} $size={size}>
        {STRAINS.map((strain) => (
          <Key
            key={strain}
            type="button"
            $size={size}
            disabled={level === null || !allowed.has(`${level}${strain}`)}
            onClick={() => level !== null && call(`${level}${strain}`)}
          >
            <SuitSymbol suit={strain} onCard />
          </Key>
        ))}
      </Grid>
      <Grid $columns={4} $size={size}>
        <Key type="button" $size={size} $tone="pass" disabled={!allowed.has('P')} onClick={() => call('P')}>
          {t.pass}
        </Key>
        <Key type="button" $size={size} $tone="double" disabled={!allowed.has('X')} onClick={() => call('X')}>
          X
        </Key>
        <Key type="button" $size={size} $tone="redouble" disabled={!allowed.has('XX')} onClick={() => call('XX')}>
          XX
        </Key>
        <Key
          type="button"
          $size={size}
          $tone="alert"
          $selected={alerting}
          aria-pressed={alerting}
          onClick={() => setAlerting(!alerting)}
        >
          {t.alert}
        </Key>
      </Grid>
      {alerting && (
        <AlertInput
          autoFocus
          value={explanation}
          maxLength={LIMITS.alertMax}
          onChange={(e) => setExplanation(e.target.value)}
          placeholder={t.alertExplain}
          aria-label={t.alertExplain}
        />
      )}
    </Box>
  )
}
