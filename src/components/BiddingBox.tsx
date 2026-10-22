import { useState } from 'react'
import styled, { css } from 'styled-components'
import { LEVELS, STRAINS, type Call } from '../../shared/auction.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { bidKeyHeight } from '../lib/measure.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { SuitSymbol } from './Suit.tsx'

/**
 * BBO's bidding box, two rows high so it fits under the auction: Pass and the levels 1–7 on top,
 * X, XX, the strains and Alert below. Pick a level, then a strain, and the bid is made. Pass, X
 * and XX are green, red and blue; Alert attaches an explanation that only the opponents see,
 * typed in a field that floats below the box so the box never changes height. `size` scales the
 * keys with the cards at the table.
 */

const Box = styled.div<{ $size: number }>`
  position: relative;
  display: grid;
  gap: ${({ $size }) => Math.round($size * 0.08)}px;
  width: min(100%, ${({ $size }) => Math.round($size * 8.2)}px);
  padding: ${({ $size }) => Math.round($size * 0.12)}px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
`

const Grid = styled.div<{ $size: number }>`
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: ${({ $size }) => Math.round($size * 0.08)}px;
`

const Key = styled.button<{ $tone?: 'pass' | 'double' | 'redouble' | 'alert'; $selected?: boolean; $wide?: boolean; $size: number }>`
  ${({ $wide }) => $wide && 'grid-column: span 2;'}
  height: ${({ $size }) => bidKeyHeight($size)}px;
  padding: 0 2px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 6px;
  background: ${({ theme }) => theme.table.bidButton};
  color: ${({ theme }) => theme.table.bidButtonText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-size: ${({ $size }) => Math.max(16, Math.round($size * 0.36))}px;
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
      font-size: ${Math.max(14, Math.round($size * 0.28))}px;
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
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 5;
  min-height: 38px;
  padding: 4px 8px;
  border: 2px solid ${({ theme }) => theme.table.bidAlert};
  border-radius: 6px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  background: ${({ theme }) => theme.table.alertField};
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
      <Grid $size={size}>
        <Key type="button" $size={size} $tone="pass" $wide disabled={!allowed.has('P')} onClick={() => call('P')}>
          {t.pass}
        </Key>
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
      <Grid $size={size}>
        <Key type="button" $size={size} $tone="double" disabled={!allowed.has('X')} onClick={() => call('X')}>
          X
        </Key>
        <Key type="button" $size={size} $tone="redouble" disabled={!allowed.has('XX')} onClick={() => call('XX')}>
          XX
        </Key>
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
        <Key
          type="button"
          $size={size}
          $tone="alert"
          $wide
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
