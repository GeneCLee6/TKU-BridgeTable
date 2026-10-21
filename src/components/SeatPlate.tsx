import { Bot, X } from 'lucide-react'
import styled, { css, keyframes } from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { SeatOccupant } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'

/**
 * A player's name plate, as on BBO: the seat letter and name, red when that side is vulnerable,
 * a pulsing yellow ring when it is their turn. Empty seats offer "sit" and "add robot"; a robot's
 * plate can remove it.
 */

const pulse = keyframes`
  0%, 100% { box-shadow: 0 0 0 3px rgba(255, 212, 59, 0.95); }
  50% { box-shadow: 0 0 0 6px rgba(255, 212, 59, 0.45); }
`

const Plate = styled.div<{ $vul: boolean; $turn: boolean; $offline: boolean; $compact: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 34px;
  padding: 3px 12px 3px 4px;
  border-radius: 7px;
  background: ${({ $vul, theme }) => ($vul ? theme.table.plateVul : theme.table.plate)};
  color: ${({ $vul, theme }) => ($vul ? theme.table.plateVulText : theme.table.plateText)};
  font-size: 16px;
  font-weight: 700;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
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
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.14);
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 800;
`

const Name = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Tag = styled.span`
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
`

const SmallButton = styled.button<{ $tone?: 'robot' | 'remove' }>`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: ${({ theme, $tone }) =>
    $tone === 'robot' ? theme.table.bidRedouble : $tone === 'remove' ? 'rgba(0, 0, 0, 0.2)' : theme.table.bidPass};
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
`

export function SeatPlate({
  seat,
  occupant,
  vulnerable,
  turn,
  role,
  isMe,
  onSit,
  onFree,
  onAddRobot,
  onRemoveRobot,
  compact = false,
}: {
  seat: Seat
  occupant: SeatOccupant | null
  vulnerable: boolean
  turn: boolean
  role?: 'declarer' | 'dummy'
  isMe: boolean
  onSit?: () => void
  onFree?: () => void
  onAddRobot?: () => void
  onRemoveRobot?: () => void
  /** Stacked and narrow, for the side seats on a phone */
  compact?: boolean
}) {
  const t = useT()
  const offline = !!occupant && !occupant.online
  return (
    <Plate $vul={vulnerable} $turn={turn} $offline={offline} $compact={compact} data-seat={seat}>
      <Letter>{seatLetter[seat]}</Letter>
      {occupant ? (
        <Name>
          {occupant.robot && <Bot size={18} aria-hidden />}
          {occupant.robot ? t.robot : occupant.username}
          {isMe && t.youTag}
        </Name>
      ) : !onSit && !onAddRobot ? (
        <Name>{t.emptySeat}</Name>
      ) : null}
      {(!occupant || occupant.robot) && onSit && (
        <SmallButton type="button" onClick={onSit}>
          {t.takeSeat(seatLetter[seat])}
        </SmallButton>
      )}
      {!occupant && onAddRobot && (
        <SmallButton type="button" $tone="robot" onClick={onAddRobot} aria-label={`${t.addRobot} ${seatLetter[seat]}`}>
          <Bot size={16} aria-hidden />
          {!compact && t.addRobot}
        </SmallButton>
      )}
      {occupant?.robot && onRemoveRobot && (
        <SmallButton type="button" $tone="remove" onClick={onRemoveRobot} aria-label={`${t.removeRobot} ${seatLetter[seat]}`} title={t.removeRobot}>
          <X size={16} aria-hidden />
        </SmallButton>
      )}
      {role && <Tag>{role === 'declarer' ? t.declarer : t.dummy}</Tag>}
      {offline && <Tag>{t.offline}</Tag>}
      {offline && onFree && (
        <SmallButton type="button" onClick={onFree}>
          {t.freeSeat}
        </SmallButton>
      )}
      {turn && <span className="visually-hidden">{t.waitingFor(occupant?.username ?? seatLetter[seat])}</span>}
    </Plate>
  )
}
