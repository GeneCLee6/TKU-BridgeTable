import { useState } from 'react'
import styled, { css } from 'styled-components'
import type { AuctionCall } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Seat } from '../../shared/cards.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { CallLabel } from './Suit.tsx'

/**
 * The auction as a table, BBO style: four columns from the viewer's point of view (left-hand
 * opponent, partner, right-hand opponent, the viewer last), vulnerable seats with a red header,
 * the dealer's first call in the dealer's column and '?' where the next call goes. Alerted calls
 * are yellow; click one to read its explanation.
 */

const Box = styled.div<{ $size: number }>`
  width: 100%;
  max-width: ${({ $size }) => Math.round($size * 4.4)}px;
  border-radius: 6px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: ${({ theme }) => theme.fonts.cards};
`

const Table = styled.table<{ $size: number }>`
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: ${({ $size }) => Math.round($size * 0.3)}px;
  font-weight: 700;
  text-align: center;
`

const Head = styled.th<{ $vul: boolean }>`
  padding: 2px 0;
  font-size: 0.85em;
  ${({ $vul, theme }) =>
    $vul
      ? css`
          background: ${theme.table.plateVul};
          color: ${theme.table.plateVulText};
        `
      : css`
          background: ${theme.table.panelBorder};
        `}
`

const Cell = styled.td<{ $alert?: boolean; $call?: string; $size: number }>`
  height: ${({ $size }) => Math.round($size * 0.5)}px;
  padding: 0;
  color: ${({ $call, theme }) =>
    $call === 'P' ? theme.table.bidPass : $call === 'X' ? theme.table.bidDouble : $call === 'XX' ? theme.table.bidRedouble : 'inherit'};
  ${({ $alert, theme }) =>
    $alert &&
    css`
      background: ${theme.table.alert};
      cursor: pointer;
    `}
`

const Explain = styled.p`
  margin: 0;
  padding: 4px 8px;
  border-top: 1px solid ${({ theme }) => theme.table.panelBorder};
  font-size: 14px;
  font-family: ${({ theme }) => theme.fonts.body};
`

export function AuctionBox({
  auction,
  dealer,
  vul,
  viewer = 'S',
  turn,
  size = 56,
}: {
  auction: AuctionCall[]
  dealer: Seat
  vul: Vulnerability
  /** The seat shown in the last column; spectators see South's view */
  viewer?: Seat
  /** Shows '?' in this seat's next cell while the auction is running */
  turn?: Seat | null
  /** Scale, roughly the card width at the table */
  size?: number
}) {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  const order: Seat[] = [nextSeat(viewer, 1), nextSeat(viewer, 2), nextSeat(viewer, 3), viewer]
  const offset = order.indexOf(dealer)
  const cells: (AuctionCall | 'turn' | null)[] = [...Array(offset).fill(null), ...auction]
  if (turn) cells.push('turn')
  const rows = Array.from({ length: Math.max(1, Math.ceil(cells.length / 4)) }, (_, r) => cells.slice(r * 4, r * 4 + 4))
  const explained = open !== null ? auction[open] : undefined
  const cellSize = Math.max(44, size)

  return (
    <Box $size={cellSize}>
      <Table $size={cellSize} aria-label={t.auction}>
        <thead>
          <tr>
            {order.map((seat) => (
              <Head key={seat} scope="col" $vul={isVulnerable(vul, seat)}>
                {seatLetter[seat]}
              </Head>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {order.map((_, c) => {
                const cell = row[c]
                if (!cell) return <Cell key={c} $size={cellSize} />
                if (cell === 'turn')
                  return (
                    <Cell key={c} $size={cellSize}>
                      ?
                    </Cell>
                  )
                const index = auction.indexOf(cell)
                const alerted = cell.alert !== undefined
                return (
                  <Cell
                    key={c}
                    $size={cellSize}
                    $call={cell.call}
                    $alert={alerted}
                    onClick={alerted ? () => setOpen(open === index ? null : index) : undefined}
                    title={alerted ? cell.alert || t.alert : undefined}
                  >
                    <CallLabel call={cell.call} onCard />
                    {alerted && <span className="visually-hidden">（Alert：{cell.alert}）</span>}
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      {explained && (
        <Explain>
          <CallLabel call={explained.call} onCard />：{explained.alert || t.alert}
        </Explain>
      )}
    </Box>
  )
}
