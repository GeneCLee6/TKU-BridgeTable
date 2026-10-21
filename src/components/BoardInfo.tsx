import styled, { css } from 'styled-components'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import type { Seat } from '../../shared/cards.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import type { Position } from './TrickArea.tsx'

/**
 * BBO's board marker: a small compass with the board number in the middle, vulnerable seats in
 * red and the dealer underlined. It turns with the table so the viewer's seat is at the bottom.
 */

const Compass = styled.div<{ $size: number }>`
  display: grid;
  grid-template-columns: ${({ $size }) => `${$size}px ${$size * 1.5}px ${$size}px`};
  grid-template-rows: ${({ $size }) => `${$size}px ${$size * 1.5}px ${$size}px`};
  border-radius: 8px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
  font-size: ${({ $size }) => Math.round($size * 0.6)}px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
`

const Mark = styled.div<{ $vul: boolean; $dealer: boolean; $area: string }>`
  grid-area: ${({ $area }) => $area};
  display: flex;
  align-items: center;
  justify-content: center;
  ${({ $vul, theme }) =>
    $vul &&
    css`
      background: ${theme.table.plateVul};
      color: ${theme.table.plateVulText};
    `}
  ${({ $dealer }) =>
    $dealer &&
    css`
      text-decoration: underline;
      text-decoration-thickness: 2px;
      text-underline-offset: 2px;
    `}
`

const BoardNumber = styled.div`
  grid-area: 2 / 2;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.4em;
`

const AREAS: Record<Position, string> = { bottom: '3 / 2', left: '2 / 1', top: '1 / 2', right: '2 / 3' }

export function BoardInfo({
  boardNo,
  dealer,
  vul,
  positions,
  size = 24,
}: {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  positions: Record<Position, Seat>
  size?: number
}) {
  const t = useT()
  const label = `${t.boardNo(boardNo)}，${t.dealer} ${seatLetter[dealer]}，${t.vulNames[vul]}`
  return (
    <Compass $size={size} role="img" aria-label={label} title={label}>
      {(Object.keys(AREAS) as Position[]).map((area) => {
        const seat = positions[area]
        return (
          <Mark key={area} $area={AREAS[area]} $vul={isVulnerable(vul, seat)} $dealer={seat === dealer}>
            {seatLetter[seat]}
          </Mark>
        )
      })}
      <BoardNumber>{boardNo}</BoardNumber>
    </Compass>
  )
}
