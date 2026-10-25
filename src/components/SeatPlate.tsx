import { Bot, ChevronDown, Crown, Timer } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import styled, { css, keyframes } from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { SeatOccupant } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { playerName, seatLetter } from '../strings.ts'

/**
 * A player's name plate, as on BBO: the seat letter and name on the left, declarer / dummy /
 * offline on the right, red when that side is vulnerable, a pulsing yellow ring when it is their
 * turn, and a crown before the host's name. Clicking the plate opens the seat's menu (sit here,
 * and for the host: add or remove a robot, ask a player to leave) when there is anything to do.
 * The menu floats above the page next to the plate, so it stays upright even when the seat is
 * turned on its side (the left and right seats on a phone).
 *
 * At a table with a time limit the plate of the player to act counts down the board's time (red
 * once it is over, AC-2.10); a player who has kept the table waiting SLOW_TURN_MS blinks. A robot
 * sitting in for someone who dropped offline says for whom (代打, AC-2.13).
 */

export interface SeatAction {
  label: string
  onSelect: () => void
  tone?: 'danger'
}

const pulse = keyframes`
  0%, 100% { box-shadow: 0 0 0 3px rgba(255, 212, 59, 0.95); }
  50% { box-shadow: 0 0 0 6px rgba(255, 212, 59, 0.45); }
`

const blink = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
`

const Wrap = styled.div`
  position: relative;
  display: flex;
  min-width: 0;
  max-width: 100%;
`

const Plate = styled.div<{
  $vul: boolean
  $turn: boolean
  $slow: boolean
  $offline: boolean
  $compact: boolean
  $clickable: boolean
}>`
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: 100%;
  min-height: 34px;
  padding: 3px 10px 3px 4px;
  border: 0;
  border-radius: 7px;
  background: ${({ $vul, theme }) => ($vul ? theme.table.plateVul : theme.table.plate)};
  color: ${({ $vul, theme }) => ($vul ? theme.table.plateVulText : theme.table.plateText)};
  font: inherit;
  font-size: 16px;
  font-weight: 700;
  text-align: left;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  ${({ $clickable }) => $clickable && 'cursor: pointer;'}
  ${({ $turn }) =>
    $turn &&
    css`
      animation: ${pulse} 1.6s ease-in-out infinite;
    `}
  ${({ $slow }) =>
    $slow &&
    css`
      animation: ${pulse} 1.6s ease-in-out infinite, ${blink} 0.9s ease-in-out infinite;
    `}
  ${({ $offline }) => $offline && 'opacity: 0.7;'}
  ${({ $compact }) =>
    $compact &&
    css`
      gap: 4px;
      min-height: 24px;
      padding: 2px 6px 2px 2px;
      border-radius: 5px;
      font-size: 12px;
      & [data-letter] { width: 20px; height: 20px; }
      & [data-tag] { padding: 0 5px; font-size: 11px; }
    `}
`

const Letter = styled.span`
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.14);
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 800;
`

const Name = styled.span<{ $muted?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  ${({ $muted }) => $muted && 'opacity: 0.65; font-weight: 600;'}

  & > svg { flex: none; }
  & > [data-crown] { color: ${({ theme }) => theme.table.crown}; }
`

/** Declarer / dummy / offline, pushed to the right end of the plate */
const Tags = styled.span`
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
`

const Muted = styled.span`
  font-size: 0.8em;
  font-weight: 600;
  opacity: 0.75;
`

const Tag = styled.span`
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

const ClockTag = styled(Tag)<{ $over: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-variant-numeric: tabular-nums;
  ${({ $over, theme }) => $over && `background: ${theme.table.bidDouble}; color: ${theme.table.plateVulText};`}
`

/** The time, kept current once a second while `active` */
function useSecondClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

const mmss = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** What is left of the board's time limit, on the plate of the player to act */
function BoardClock({ endsAt }: { endsAt: number }) {
  const t = useT()
  const now = useSecondClock(true)
  const left = endsAt - now
  const over = left <= 0
  return (
    <ClockTag data-tag $over={over} role="timer" aria-label={over ? t.overtime : t.boardTimeLeft(mmss(left))}>
      <Timer size={13} aria-hidden />
      {over ? t.overtime : mmss(left)}
    </ClockTag>
  )
}

const MENU_WIDTH = 220

const Menu = styled.div`
  position: fixed;
  z-index: 40;
  display: grid;
  width: ${MENU_WIDTH}px;
  padding: 6px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.panel};
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
`

const MenuItem = styled.button<{ $tone?: 'danger' }>`
  min-height: 38px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: ${({ theme, $tone }) => ($tone === 'danger' ? theme.table.bidDouble : theme.table.panelText)};
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  &:hover, &:focus-visible { background: ${({ theme }) => theme.table.panelBorder}; }
`

export function SeatPlate({
  seat,
  occupant,
  vulnerable,
  turn,
  role,
  isMe,
  isHost = false,
  actions = [],
  menuUp = false,
  compact = false,
  endsAt = null,
  slow = false,
}: {
  seat: Seat
  occupant: SeatOccupant | null
  vulnerable: boolean
  turn: boolean
  role?: 'declarer' | 'dummy'
  isMe: boolean
  /** The occupant runs the table: a crown before the name */
  isHost?: boolean
  /** What the viewer may do with this seat; the plate opens a menu of them */
  actions?: SeatAction[]
  /** Open the menu above the plate (the bottom seat) */
  menuUp?: boolean
  /** Small, for the seats turned on their side on a phone */
  compact?: boolean
  /** When the board's time limit runs out (this browser's clock); shown while it is this seat's turn */
  endsAt?: number | null
  /** This player has kept the table waiting SLOW_TURN_MS: the plate blinks */
  slow?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState<CSSProperties | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const offline = !!occupant && !occupant.online
  const clickable = actions.length > 0

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (!wrap.current?.contains(target) && !menu.current?.contains(target)) setOpen(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null)
    // The menu is placed once; if the page moves under it, it simply closes
    const close = () => setOpen(null)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  /** Next to the plate, centred on it, kept inside the window; above it near the bottom */
  const toggle = () => {
    if (open) return setOpen(null)
    const plate = wrap.current?.getBoundingClientRect()
    if (!plate) return
    const left = Math.min(Math.max(8, plate.left + plate.width / 2 - MENU_WIDTH / 2), window.innerWidth - MENU_WIDTH - 8)
    const up = menuUp || plate.bottom > window.innerHeight - 160
    setOpen(up ? { left, bottom: window.innerHeight - plate.top + 6 } : { left, top: plate.bottom + 6 })
  }

  const name = occupant ? (
    <Name>
      {isHost && <Crown size={16} aria-label={t.host} data-crown />}
      {occupant.robot && <Bot size={18} aria-hidden />}
      {occupant.robot ? t.robotName : playerName(t, occupant)}
      {isMe && t.youTag}
      {occupant.substituteFor && <Muted>{t.substituteFor(occupant.substituteFor)}</Muted>}
    </Name>
  ) : (
    <Name $muted>{t.emptySeat}</Name>
  )

  return (
    <Wrap ref={wrap}>
      <Plate
        as={clickable ? 'button' : 'div'}
        type={clickable ? 'button' : undefined}
        onClick={clickable ? toggle : undefined}
        aria-haspopup={clickable ? 'menu' : undefined}
        aria-expanded={clickable ? !!open : undefined}
        $vul={vulnerable}
        $turn={turn}
        $slow={slow}
        $offline={offline}
        $compact={compact}
        $clickable={clickable}
        data-seat={seat}
      >
        <Letter data-letter>{seatLetter[seat]}</Letter>
        {name}
        {(role || offline || clickable || occupant?.robot || (turn && endsAt !== null)) && (
          <Tags>
            {turn && endsAt !== null && <BoardClock endsAt={endsAt} />}
            {occupant?.robot && (
              <Tag data-tag data-system={occupant.robotKind ?? 'tku'}>
                {t.robotSystems[occupant.robotKind ?? 'tku']}
              </Tag>
            )}
            {role && <Tag data-tag>{role === 'declarer' ? t.declarer : t.dummy}</Tag>}
            {offline && <Tag data-tag>{t.offline}</Tag>}
            {clickable && <ChevronDown size={compact ? 13 : 16} aria-hidden />}
          </Tags>
        )}
        {turn && <span className="visually-hidden">{t.waitingFor(occupant?.username ?? seatLetter[seat])}</span>}
        {slow && <span className="visually-hidden">{t.slowTurn}</span>}
      </Plate>
      {open &&
        createPortal(
          <Menu ref={menu} role="menu" aria-label={t.seatOptions(seatLetter[seat])} style={open}>
            {actions.map((action) => (
              <MenuItem
                key={action.label}
                type="button"
                role="menuitem"
                $tone={action.tone}
                onClick={() => {
                  setOpen(null)
                  action.onSelect()
                }}
              >
                {action.label}
              </MenuItem>
            ))}
          </Menu>,
          document.body,
        )}
    </Wrap>
  )
}
