import styled, { css } from 'styled-components'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import type { Seat } from '../../shared/cards.ts'
import { seatLetter, strings } from '../strings.ts'

/**
 * BBO's board marker: a small compass with the board number in the middle, vulnerable seats in
 * red and the dealer marked. It turns with the table so the viewer's seat is at the bottom.
 */

const Compass = styled.div`
  display: grid;
  grid-template-columns: 22px 34px 22px;
  grid-template-rows: 22px 34px 22px;
  border-radius: 6px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  font-family: ${({ theme }) => theme.fonts.cards};
  font-weight: 700;
  font-size: 13px;
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
  font-size: 18px;
`

const AREAS = { bottom: '3 / 2', left: '2 / 1', top: '1 / 2', right: '2 / 3' } as const

export function BoardInfo({
  boardNo,
  dealer,
  vul,
  positions,
}: {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  positions: Record<keyof typeof AREAS, Seat>
}) {
  const label = `${strings.boardNo(boardNo)}，${strings.dealer} ${seatLetter[dealer]}，${strings.vulNames[vul]}`
  return (
    <Compass role="img" aria-label={label} title={label}>
      {(Object.keys(AREAS) as (keyof typeof AREAS)[]).map((area) => {
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
