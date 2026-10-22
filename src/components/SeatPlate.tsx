import { Bot, ChevronDown, Crown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import styled, { css, keyframes } from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { SeatOccupant } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'

/**
 * A player's name plate, as on BBO: the seat letter and name on the left, declarer / dummy /
 * offline on the right, red when that side is vulnerable, a pulsing yellow ring when it is their
 * turn, and a crown before the host's name. Clicking the plate opens the seat's menu (sit here,
 * and for the host: add or remove a robot, ask a player to leave) when there is anything to do.
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

const Wrap = styled.div`
  position: relative;
  display: flex;
  min-width: 0;
  max-width: 100%;
`

const Plate = styled.div<{ $vul: boolean; $turn: boolean; $offline: boolean; $compact: boolean; $clickable: boolean }>`
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
  ${({ $offline }) => $offline && 'opacity: 0.7;'}
  ${({ $compact }) =>
    $compact &&
    css`
      flex-direction: column;
      gap: 2px;
      padding: 3px;
      font-size: 12px;
      & > span { max-width: 64px; }
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

const Tag = styled.span`
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

const Menu = styled.div<{ $up: boolean }>`
  position: absolute;
  left: 50%;
  z-index: 20;
  ${({ $up }) => ($up ? 'bottom: calc(100% + 6px);' : 'top: calc(100% + 6px);')}
  display: grid;
  min-width: 180px;
  padding: 6px;
  border-radius: 10px;
  background: ${({ theme }) => theme.table.panel};
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  transform: translateX(-50%);
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
  /** Stacked and narrow, for the side seats on a phone */
  compact?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const offline = !!occupant && !occupant.online
  const clickable = actions.length > 0

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const name = occupant ? (
    <Name>
      {isHost && <Crown size={16} aria-label={t.host} data-crown />}
      {occupant.robot && <Bot size={18} aria-hidden />}
      {occupant.robot ? t.robot : occupant.username}
      {isMe && t.youTag}
    </Name>
  ) : (
    <Name $muted>{t.emptySeat}</Name>
  )

  return (
    <Wrap ref={wrap}>
      <Plate
        as={clickable ? 'button' : 'div'}
        type={clickable ? 'button' : undefined}
        onClick={clickable ? () => setOpen(!open) : undefined}
        aria-haspopup={clickable ? 'menu' : undefined}
        aria-expanded={clickable ? open : undefined}
        $vul={vulnerable}
        $turn={turn}
        $offline={offline}
        $compact={compact}
        $clickable={clickable}
        data-seat={seat}
      >
        <Letter>{seatLetter[seat]}</Letter>
        {name}
        {(role || offline || clickable) && (
          <Tags>
            {role && <Tag>{role === 'declarer' ? t.declarer : t.dummy}</Tag>}
            {offline && <Tag>{t.offline}</Tag>}
            {clickable && !compact && <ChevronDown size={16} aria-hidden />}
          </Tags>
        )}
        {turn && <span className="visually-hidden">{t.waitingFor(occupant?.username ?? seatLetter[seat])}</span>}
      </Plate>
      {open && (
        <Menu role="menu" aria-label={t.seatOptions(seatLetter[seat])} $up={menuUp}>
          {actions.map((action) => (
            <MenuItem
              key={action.label}
              type="button"
              role="menuitem"
              $tone={action.tone}
              onClick={() => {
                setOpen(false)
                action.onSelect()
              }}
            >
              {action.label}
            </MenuItem>
          ))}
        </Menu>
      )}
    </Wrap>
  )
}
