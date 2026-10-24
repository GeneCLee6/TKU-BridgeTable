import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import styled, { css } from 'styled-components'
import { LEVELS, STRAINS, type Call } from '../../shared/auction.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { bidKeyHeight } from '../lib/measure.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { CallLabel, SuitSymbol } from './Suit.tsx'

/**
 * BBO's bidding box, two rows high so it fits under the auction: Pass and the levels 1–7 on top,
 * X, XX, the strains and Alert below. Pick a level, then a strain, and the bid is made. Pass, X
 * and XX are green, red and blue; Alert attaches an explanation that only the opponents see,
 * typed in a field that floats below the box so the box never changes height. `size` scales the
 * keys with the cards at the table.
 *
 * With `hints` (a 2/1 robot partner), pointing at a call shows how the robot will read it, as GIB
 * does on BBO: hover with a mouse, focus with the keyboard, or press and hold on a phone (holding
 * does not make the call). The hint floats above the box.
 */

export interface BiddingHints {
  /** Whose reading this is, e.g. "2/1 機器人的理解" */
  title: string
  /** What a call would show */
  text: (call: Call) => string
}

/** How long a finger must stay on a key to see its hint instead of making the call */
const HOLD_MS = 450

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
  -webkit-touch-callout: none;

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

/** How a 2/1 robot partner reads the call under the pointer, floating above the box */
const Hint = styled.div`
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 5;
  padding: 6px 10px 8px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 8px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-size: 15px;
  line-height: 1.45;
  pointer-events: none;

  & > strong {
    display: block;
    font-size: 13px;
    opacity: 0.8;
  }
  & > strong > span {
    margin-right: 6px;
    font-family: ${({ theme }) => theme.fonts.cards};
    font-size: 16px;
  }
`

export function BiddingBox({
  legal,
  onCall,
  size = 60,
  hints,
}: {
  legal: Call[]
  onCall: (call: Call, alert?: string) => void
  size?: number
  /** How a 2/1 robot partner reads each call, if the partner is one */
  hints?: BiddingHints | null
}) {
  const t = useT()
  const [level, setLevel] = useState<number | null>(null)
  const [alerting, setAlerting] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [hinted, setHinted] = useState<Call | null>(null)
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; shown: boolean }>({ timer: null, shown: false })
  const allowed = new Set(legal)

  useEffect(() => {
    const current = hold.current
    return () => {
      if (current.timer) clearTimeout(current.timer)
    }
  }, [])

  const call = (value: Call) => {
    // The finger was held down to read the hint: no call this time
    if (hold.current.shown) {
      hold.current.shown = false
      return
    }
    onCall(value, alerting ? explanation.trim() : undefined)
    setLevel(null)
    setAlerting(false)
    setExplanation('')
    setHinted(null)
  }

  /** What makes a key show its hint: hover, keyboard focus, or a long press */
  const hintFor = (value: Call | null) => {
    if (!hints || !value) return {}
    const stopHold = () => {
      if (hold.current.timer) clearTimeout(hold.current.timer)
      hold.current.timer = null
    }
    return {
      onPointerEnter: (e: ReactPointerEvent) => {
        if (e.pointerType !== 'touch') setHinted(value)
      },
      onPointerLeave: (e: ReactPointerEvent) => {
        stopHold()
        if (e.pointerType !== 'touch') setHinted((h) => (h === value ? null : h))
      },
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.pointerType !== 'touch') return
        hold.current.shown = false
        stopHold()
        hold.current.timer = setTimeout(() => {
          hold.current.shown = true
          setHinted(value)
        }, HOLD_MS)
      },
      onPointerUp: stopHold,
      onPointerCancel: stopHold,
      // Holding a key on a phone must not open the browser's menu
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
      onFocus: () => setHinted(value),
      onBlur: () => setHinted((h) => (h === value ? null : h)),
    }
  }

  return (
    <Box $size={size} role="group" aria-label={t.biddingBox}>
      {hints && hinted && allowed.has(hinted) && (
        <Hint role="status">
          <strong>
            <span>
              <CallLabel call={hinted} onCard />
            </span>
            {hints.title}
          </strong>
          {hints.text(hinted)}
        </Hint>
      )}
      <Grid $size={size}>
        <Key type="button" $size={size} $tone="pass" $wide disabled={!allowed.has('P')} onClick={() => call('P')} {...hintFor('P')}>
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
        <Key type="button" $size={size} $tone="double" disabled={!allowed.has('X')} onClick={() => call('X')} {...hintFor('X')}>
          X
        </Key>
        <Key type="button" $size={size} $tone="redouble" disabled={!allowed.has('XX')} onClick={() => call('XX')} {...hintFor('XX')}>
          XX
        </Key>
        {STRAINS.map((strain) => (
          <Key
            key={strain}
            type="button"
            $size={size}
            disabled={level === null || !allowed.has(`${level}${strain}`)}
            onClick={() => level !== null && call(`${level}${strain}`)}
            {...hintFor(level === null ? null : `${level}${strain}`)}
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
