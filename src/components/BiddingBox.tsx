import { BookOpen } from 'lucide-react'
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import styled, { css } from 'styled-components'
import { LEVELS, STRAINS, type Call } from '../../shared/auction.ts'
import { LIMITS } from '../../shared/protocol.ts'
import { bidKeyHeight } from '../lib/measure.ts'
import { typingIn } from '../lib/useCardChoice.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { CallLabel, SuitSymbol, SuitText } from './Suit.tsx'

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
 *
 * With `confirm` (BBO's "confirm bids") a click only chooses the call; a bar above the box shows
 * it with a confirm button, and the call is made from there. The keyboard always works that way:
 * `1`–`7` then `c d h s n` choose a bid, `p` Pass, `x` X (or XX), `Enter` sends, `Esc` cancels.
 * The letters are printed in the corner of their keys where there is a keyboard.
 */

export interface BiddingHints {
  /** Whose reading this is, e.g. "TKB（2/1）的理解" */
  title: string
  /** What a call would show */
  text: (call: Call) => string
  /** TKB in the club's system: 淡江橋館's words for the call (BridgeHall e7-t05) */
  book?: (call: Call) => string | undefined
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
  position: relative;
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
      color: ${theme.table.bidButtonText};
    `}

  &:disabled {
    background: ${({ theme }) => theme.table.bidDisabled};
    border-color: ${({ theme }) => theme.table.bidDisabled};
    color: rgba(0, 0, 0, 0.35);
    opacity: 0.7;
  }
`

/** The key that chooses a call, small in the key's corner; hidden on touch screens */
const KeyCap = styled.span<{ $size: number }>`
  position: absolute;
  top: 2px;
  right: 3px;
  font-family: ${({ theme }) => theme.fonts.body};
  font-size: ${({ $size }) => Math.max(9, Math.round($size * 0.17))}px;
  font-weight: 600;
  line-height: 1;
  opacity: 0.6;

  @media (hover: none) {
    display: none;
  }
`

/** Read by screen readers only: which keys work */
const KeysHint = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
`

/** Above the box: the robot's reading and the call waiting to be confirmed */
const Above = styled.div`
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 5;
  display: grid;
  gap: 4px;
  pointer-events: none;
`

const ConfirmBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 2px solid ${({ theme }) => theme.table.panelText};
  border-radius: 8px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  pointer-events: auto;

  & > strong {
    flex: 1;
    font-family: ${({ theme }) => theme.fonts.cards};
    font-size: 20px;
  }
  & > button {
    min-height: 36px;
    padding: 0 14px;
    border: 1px solid ${({ theme }) => theme.table.panelBorder};
    border-radius: 6px;
    background: ${({ theme }) => theme.table.bidButton};
    color: ${({ theme }) => theme.table.bidButtonText};
    font-weight: 700;
  }
  & > button:first-of-type {
    background: ${({ theme }) => theme.table.bidSelected};
    border-color: ${({ theme }) => theme.table.panelText};
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
  padding: 6px 10px 8px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 8px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.4);
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-size: 15px;
  line-height: 1.45;
  /* An explanation's second line: what the player had already shown */
  white-space: pre-line;

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

/** The handbook's words under the robot's reading */
const BookWords = styled.span`
  display: block;
  margin-top: 6px;

  & > strong {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    opacity: 0.8;
  }
`

export function BiddingBox({
  legal,
  onCall,
  size = 60,
  hints,
  confirm = false,
}: {
  legal: Call[]
  onCall: (call: Call, alert?: string) => void
  size?: number
  /** How a 2/1 robot partner reads each call, if the partner is one */
  hints?: BiddingHints | null
  /** A click only chooses the call; it is made from the confirm bar */
  confirm?: boolean
}) {
  const t = useT()
  const keysId = useId()
  const [level, setLevel] = useState<number | null>(null)
  const [chosen, setChosen] = useState<Call | null>(null)
  const [alerting, setAlerting] = useState(false)
  const [explanation, setExplanation] = useState('')
  const [hinted, setHinted] = useState<Call | null>(null)
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; shown: boolean }>({ timer: null, shown: false })
  const allowed = new Set(legal)
  const waiting = chosen && allowed.has(chosen) ? chosen : null

  useEffect(() => {
    const current = hold.current
    return () => {
      if (current.timer) clearTimeout(current.timer)
    }
  }, [])

  const send = (value: Call) => {
    if (!allowed.has(value)) return
    onCall(value, alerting ? explanation.trim() : undefined)
    setLevel(null)
    setChosen(null)
    setAlerting(false)
    setExplanation('')
    setHinted(null)
  }

  const call = (value: Call) => {
    // The finger was held down to read the hint: no call this time
    if (hold.current.shown) {
      hold.current.shown = false
      return
    }
    if (confirm) setChosen(value)
    else send(value)
  }

  // The keyboard chooses with digits and letters and sends with Enter. Subscribed on every render
  // so the handler sees the current level and choice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      // In the alert field only Enter counts (it sends the chosen call); the rest is the explanation
      if (typingIn(e.target) && !(e.key === 'Enter' && waiting)) return
      const key = e.key.toUpperCase()
      const n = Number(e.key)
      if (Number.isInteger(n) && n >= 1 && n <= 7) {
        if (STRAINS.some((s) => allowed.has(`${n}${s}`))) {
          setLevel(n)
          setChosen(null)
        }
      } else if (level !== null && (STRAINS as readonly string[]).includes(key)) {
        if (allowed.has(`${level}${key}`)) setChosen(`${level}${key}`)
      } else if (key === 'P') {
        if (allowed.has('P')) setChosen('P')
      } else if (key === 'X') {
        if (allowed.has('X')) setChosen('X')
        else if (allowed.has('XX')) setChosen('XX')
      } else if (e.key === 'Enter' && waiting) {
        // Also keeps a focused key from being clicked by the same press
        e.preventDefault()
        send(waiting)
      } else if (e.key === 'Escape' && (chosen || level !== null)) {
        setChosen(null)
        setLevel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

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

  // The robot's reading follows the pointer, else the call waiting to be confirmed
  const read = hinted ?? waiting

  return (
    <Box $size={size} role="group" aria-label={t.biddingBox} aria-describedby={keysId}>
      <KeysHint id={keysId}>{t.bidKeysHint}</KeysHint>
      <Above>
        {hints && read && allowed.has(read) && (
          <Hint role="status">
            <strong>
              <span>
                <CallLabel call={read} onCard />
              </span>
              {hints.title}
            </strong>
            <SuitText text={hints.text(read)} onCard />
            {hints.book?.(read) && (
              <BookWords>
                <strong>
                  <BookOpen size={13} aria-hidden />
                  {t.bookExplanation}
                </strong>
                <SuitText text={hints.book(read)!} onCard />
              </BookWords>
            )}
          </Hint>
        )}
        {waiting && (
          <ConfirmBar role="group" aria-label={t.confirm}>
            <strong>
              <CallLabel call={waiting} onCard />
            </strong>
            <button type="button" onClick={() => send(waiting)} aria-keyshortcuts="Enter">
              {t.confirm}
            </button>
            <button type="button" onClick={() => setChosen(null)} aria-keyshortcuts="Escape">
              {t.cancel}
            </button>
          </ConfirmBar>
        )}
      </Above>
      <Grid $size={size}>
        <Key
          type="button"
          $size={size}
          $tone="pass"
          $wide
          $selected={waiting === 'P'}
          disabled={!allowed.has('P')}
          onClick={() => call('P')}
          aria-keyshortcuts="P"
          {...hintFor('P')}
        >
          Pass
          <KeyCap $size={size} aria-hidden>
            P
          </KeyCap>
        </Key>
        {LEVELS.map((n) => (
          <Key
            key={n}
            type="button"
            $size={size}
            $selected={level === n}
            disabled={!STRAINS.some((s) => allowed.has(`${n}${s}`))}
            onClick={() => {
              setLevel(level === n ? null : n)
              setChosen(null)
            }}
            aria-pressed={level === n}
            aria-keyshortcuts={String(n)}
          >
            {n}
          </Key>
        ))}
      </Grid>
      <Grid $size={size}>
        <Key
          type="button"
          $size={size}
          $tone="double"
          $selected={waiting === 'X'}
          disabled={!allowed.has('X')}
          onClick={() => call('X')}
          aria-keyshortcuts="X"
          {...hintFor('X')}
        >
          X
        </Key>
        <Key
          type="button"
          $size={size}
          $tone="redouble"
          $selected={waiting === 'XX'}
          disabled={!allowed.has('XX')}
          onClick={() => call('XX')}
          aria-keyshortcuts="X"
          {...hintFor('XX')}
        >
          XX
        </Key>
        {STRAINS.map((strain) => (
          <Key
            key={strain}
            type="button"
            $size={size}
            $selected={level !== null && waiting === `${level}${strain}`}
            disabled={level === null || !allowed.has(`${level}${strain}`)}
            onClick={() => level !== null && call(`${level}${strain}`)}
            aria-keyshortcuts={strain}
            {...hintFor(level === null ? null : `${level}${strain}`)}
          >
            <SuitSymbol suit={strain} onCard />
            <KeyCap $size={size} aria-hidden>
              {strain}
            </KeyCap>
          </Key>
        ))}
        <Key
          type="button"
          $size={size}
          $tone="alert"
          $wide
          $selected={alerting}
          aria-pressed={alerting}
          data-tour="alert"
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
