import styled, { css, keyframes } from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { SeatOccupant } from '../../shared/protocol.ts'
import { seatLetter, strings } from '../strings.ts'

/**
 * A player's name plate, as on BBO: the seat letter and name, red when that side is vulnerable,
 * a yellow ring when it is their turn. Empty seats offer a "sit" button.
 */

const pulse = keyframes`
  0%, 100% { box-shadow: 0 0 0 3px rgba(255, 212, 59, 0.9); }
  50% { box-shadow: 0 0 0 5px rgba(255, 212, 59, 0.45); }
`

const Plate = styled.div<{ $vul: boolean; $turn: boolean; $offline: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 30px;
  padding: 2px 10px 2px 4px;
  border-radius: 6px;
  background: ${({ $vul, theme }) => ($vul ? theme.table.plateVul : theme.table.plate)};
  color: ${({ $vul, theme }) => ($vul ? theme.table.plateVulText : theme.table.plateText)};
  font-size: 15px;
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  ${({ $turn }) =>
    $turn &&
    css`
      animation: ${pulse} 1.6s ease-in-out infinite;
    `}
  ${({ $offline }) => $offline && 'opacity: 0.7;'}
`

const Letter = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.14);
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
`

const Name = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const Tag = styled.span`
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.16);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
`

const SmallButton = styled.button`
  min-height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: ${({ theme }) => theme.table.bidPass};
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
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
}: {
  seat: Seat
  occupant: SeatOccupant | null
  vulnerable: boolean
  turn: boolean
  role?: 'declarer' | 'dummy'
  isMe: boolean
  onSit?: () => void
  onFree?: () => void
}) {
  return (
    <Plate $vul={vulnerable} $turn={turn} $offline={!!occupant && !occupant.online} data-seat={seat}>
      <Letter>{seatLetter[seat]}</Letter>
      {occupant ? (
        <Name>
          {occupant.username}
          {isMe && `（${strings.you}）`}
        </Name>
      ) : onSit ? (
        <SmallButton type="button" onClick={onSit}>
          {strings.takeSeat(seatLetter[seat])}
        </SmallButton>
      ) : (
        <Name>{strings.emptySeat}</Name>
      )}
      {role && <Tag>{role === 'declarer' ? strings.declarer : strings.dummy}</Tag>}
      {occupant && !occupant.online && <Tag>{strings.offline}</Tag>}
      {occupant && !occupant.online && onFree && (
        <SmallButton type="button" onClick={onFree}>
          {strings.freeSeat}
        </SmallButton>
      )}
      {turn && <span className="visually-hidden">{strings.turnOf(occupant?.username ?? seatLetter[seat])}</span>}
    </Plate>
  )
}
