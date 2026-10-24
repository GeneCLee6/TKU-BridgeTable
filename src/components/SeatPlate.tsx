import { Bot, ChevronDown, Crown } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import styled, { css, keyframes } from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import { DEFAULT_ROBOT_LEVEL, type SeatOccupant } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { playerName, seatLetter } from '../strings.ts'

/**
 * A player's name plate, as on BBO: the seat letter and name on the left, declarer / dummy /
 * offline on the right, red when that side is vulnerable, a pulsing yellow ring when it is their
 * turn, and a crown before the host's name. Clicking the plate opens the seat's menu (sit here,
 * and for the host: add or remove a robot, ask a player to leave) when there is anything to do.
 * The menu floats above the page next to the plate, so it stays upright even when the seat is
 * turned on its side (the left and right seats on a phone).
 */

export interface SeatAction {
  label: string
  /** Not needed when the action is a choice among `options` */
  onSelect?: () => void
  tone?: 'danger'
  /** A row of choices under the label, e.g. the robot levels; the label is then a heading */
  options?: SeatOption[]
}

export interface SeatOption {
  label: string
  /** The whole choice, for screen readers (e.g. "放淡江機器人：初學者") */
  name: string
  onSelect: () => void
  /** The table's default: shown stronger */
  current?: boolean
  /** Shown but not available yet; `hint` says why */
  disabled?: boolean
  hint?: string
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

const Tag = styled.span`
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

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

const MenuGroup = styled.div`
  display: grid;
  gap: 4px;
  padding: 6px 8px 8px;

  & > span {
    color: ${({ theme }) => theme.table.panelMuted};
    font-size: 13px;
    font-weight: 700;
  }
`

const Options = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
`

const OptionButton = styled.button<{ $current: boolean }>`
  min-height: 32px;
  padding: 0 9px;
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 999px;
  background: ${({ theme, $current }) => ($current ? theme.table.panelBorder : 'none')};
  color: ${({ theme }) => theme.table.panelText};
  font-size: 14px;
  font-weight: ${({ $current }) => ($current ? 800 : 600)};
  white-space: nowrap;
  &:hover:not(:disabled), &:focus-visible { background: ${({ theme }) => theme.table.panelBorder}; }
  &:disabled { color: ${({ theme }) => theme.table.panelMuted}; border-style: dashed; cursor: not-allowed; }
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
  /** Small, for the seats turned on their side on a phone */
  compact?: boolean
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
      {playerName(t, occupant)}
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
        onClick={clickable ? toggle : undefined}
        aria-haspopup={clickable ? 'menu' : undefined}
        aria-expanded={clickable ? !!open : undefined}
        $vul={vulnerable}
        $turn={turn}
        $offline={offline}
        $compact={compact}
        $clickable={clickable}
        data-seat={seat}
      >
        <Letter data-letter>{seatLetter[seat]}</Letter>
        {name}
        {(role || offline || clickable || occupant?.robot) && (
          <Tags>
            {occupant?.robot && (
              <Tag data-tag data-level={occupant.robotLevel ?? DEFAULT_ROBOT_LEVEL} title={t.robotLevel}>
                {t.robotLevels[occupant.robotLevel ?? DEFAULT_ROBOT_LEVEL]}
              </Tag>
            )}
            {role && <Tag data-tag>{role === 'declarer' ? t.declarer : t.dummy}</Tag>}
            {offline && <Tag data-tag>{t.offline}</Tag>}
            {clickable && <ChevronDown size={compact ? 13 : 16} aria-hidden />}
          </Tags>
        )}
        {turn && <span className="visually-hidden">{t.waitingFor(occupant?.username ?? seatLetter[seat])}</span>}
      </Plate>
      {open &&
        createPortal(
          <Menu ref={menu} role="menu" aria-label={t.seatOptions(seatLetter[seat])} style={open}>
            {actions.map((action) =>
              action.options ? (
                <MenuGroup key={action.label} role="group" aria-label={action.label}>
                  <span aria-hidden>{action.label}</span>
                  <Options>
                    {action.options.map((option) => (
                      <OptionButton
                        key={option.label}
                        type="button"
                        role="menuitem"
                        aria-label={option.hint ? `${option.name} · ${option.hint}` : option.name}
                        title={option.hint}
                        disabled={option.disabled}
                        $current={!!option.current}
                        onClick={() => {
                          setOpen(null)
                          option.onSelect()
                        }}
                      >
                        {option.label}
                      </OptionButton>
                    ))}
                  </Options>
                </MenuGroup>
              ) : (
              <MenuItem
                key={action.label}
                type="button"
                role="menuitem"
                $tone={action.tone}
                onClick={() => {
                  setOpen(null)
                  action.onSelect?.()
                }}
              >
                {action.label}
              </MenuItem>
              ),
            )}
          </Menu>,
          document.body,
        )}
    </Wrap>
  )
}
