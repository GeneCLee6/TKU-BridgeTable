import { useState } from 'react'
import styled, { css } from 'styled-components'
import type { AuctionCall } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { seatLetter, strings } from '../strings.ts'
import { CallLabel } from './Suit.tsx'

/**
 * The auction in BBO's layout: columns W N E S, vulnerable seats with a red header, the dealer's
 * first call in the dealer's column, '?' where the next call goes. Alerted calls are yellow; click
 * one to read its explanation.
 */

const ORDER: Seat[] = ['W', 'N', 'E', 'S']

const Box = styled.div`
  width: min(100%, 260px);
  border-radius: 6px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: ${({ theme }) => theme.fonts.cards};
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 15px;
  font-weight: 600;
  text-align: center;
`

const Head = styled.th<{ $vul: boolean }>`
  padding: 3px 0;
  font-size: 14px;
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

const Cell = styled.td<{ $alert?: boolean; $call?: string }>`
  height: 26px;
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
  font-size: 13px;
  font-family: ${({ theme }) => theme.fonts.body};
`

export function AuctionBox({
  auction,
  dealer,
  vul,
  turn,
}: {
  auction: AuctionCall[]
  dealer: Seat
  vul: Vulnerability
  /** Shows '?' in this seat's next cell while the auction is running */
  turn?: Seat | null
}) {
  const [open, setOpen] = useState<number | null>(null)
  const offset = ORDER.indexOf(dealer)
  const cells: (AuctionCall | 'turn' | null)[] = [...Array(offset).fill(null), ...auction]
  if (turn) cells.push('turn')
  const rows = Array.from({ length: Math.max(1, Math.ceil(cells.length / 4)) }, (_, r) => cells.slice(r * 4, r * 4 + 4))
  const explained = open !== null ? auction[open] : undefined

  return (
    <Box>
      <Table aria-label={strings.auction}>
        <thead>
          <tr>
            {ORDER.map((seat) => (
              <Head key={seat} scope="col" $vul={isVulnerable(vul, seat)}>
                {seatLetter[seat]}
              </Head>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {SEATS.map((_, c) => {
                const cell = row[c]
                if (!cell) return <Cell key={c} />
                if (cell === 'turn') return <Cell key={c}>?</Cell>
                const index = auction.indexOf(cell)
                const alerted = cell.alert !== undefined
                return (
                  <Cell
                    key={c}
                    $call={cell.call}
                    $alert={alerted}
                    onClick={alerted ? () => setOpen(open === index ? null : index) : undefined}
                    title={alerted ? cell.alert || strings.alert : undefined}
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
          <CallLabel call={explained.call} onCard />：{explained.alert || strings.alert}
        </Explain>
      )}
    </Box>
  )
}
