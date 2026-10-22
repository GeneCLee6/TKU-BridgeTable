import { useEffect, useRef, useState } from 'react'
import styled, { css } from 'styled-components'
import type { AuctionCall } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Seat } from '../../shared/cards.ts'
import { auctionBoxHeight, auctionCell } from '../lib/measure.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { CallLabel } from './Suit.tsx'

/**
 * The auction as a table, BBO style: four columns from the viewer's point of view (left-hand
 * opponent, partner, right-hand opponent, the viewer last), vulnerable seats with a red header,
 * the dealer's first call in the dealer's column and '?' where the next call goes. Alerted calls
 * are yellow; click one to read its explanation. With `maxRows` the table keeps one fixed height
 * from the first call to the last, as on BBO: a long auction scrolls inside it (the header stays
 * put, the latest round in view) and an alert explanation floats over its foot.
 */

const Box = styled.div<{ $size: number; $width?: number }>`
  position: relative;
  width: 100%;
  max-width: ${({ $size, $width }) => $width ?? Math.round($size * 4.4)}px;
  border-radius: 6px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  font-family: ${({ theme }) => theme.fonts.cards};
`

const Scroll = styled.div<{ $height?: number }>`
  ${({ $height }) => $height && `height: ${$height}px; max-height: ${$height}px; overflow-y: auto; overscroll-behavior: contain;`}
`

const Table = styled.table<{ $size: number }>`
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: ${({ $size }) => Math.round($size * 0.3)}px;
  font-weight: 700;
  text-align: center;
`

const Head = styled.th<{ $vul: boolean; $turn: boolean }>`
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 3px 2px;
  font-size: 0.85em;
  line-height: 1.15;
  ${({ $turn, theme }) => $turn && css`box-shadow: inset 0 -4px 0 ${theme.table.turn};`}
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

const HeadName = styled.span`
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ${({ theme }) => theme.fonts.body};
  font-size: 0.55em;
  font-weight: 600;
  opacity: 0.85;
`

const Explain = styled.p<{ $float: boolean }>`
  margin: 0;
  padding: 4px 8px;
  border-top: 1px solid ${({ theme }) => theme.table.panelBorder};
  background: ${({ theme }) => theme.table.panel};
  font-size: 14px;
  font-family: ${({ theme }) => theme.fonts.body};
  ${({ $float }) => $float && 'position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;'}
`

export function AuctionBox({
  auction,
  dealer,
  vul,
  viewer = 'S',
  turn,
  names,
  size = 56,
  maxRows,
  width,
}: {
  auction: AuctionCall[]
  dealer: Seat
  vul: Vulnerability
  /** The seat shown in the last column; spectators see South's view */
  viewer?: Seat
  /** Shows '?' in this seat's next cell while the auction is running */
  turn?: Seat | null
  /** Player names shown under the seat letters */
  names?: Partial<Record<Seat, string>>
  /** Scale, roughly the card width at the table */
  size?: number
  /** Rounds shown before the table scrolls; the table then keeps this height */
  maxRows?: number
  /** Widest the table may grow, in pixels (4.4 × size by default) */
  width?: number
}) {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  const order: Seat[] = [nextSeat(viewer, 1), nextSeat(viewer, 2), nextSeat(viewer, 3), viewer]
  const offset = order.indexOf(dealer)
  const cells: (AuctionCall | 'turn' | null)[] = [...Array(offset).fill(null), ...auction]
  if (turn) cells.push('turn')
  const rows = Array.from({ length: Math.max(1, Math.ceil(cells.length / 4)) }, (_, r) => cells.slice(r * 4, r * 4 + 4))
  const explained = open !== null ? auction[open] : undefined
  const cellSize = auctionCell(size)
  const scroller = useRef<HTMLDivElement>(null)

  // Keep the newest round in view as calls come in
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [auction.length, turn])

  return (
    <Box $size={cellSize} $width={width}>
      <Scroll ref={scroller} $height={maxRows ? auctionBoxHeight(size, maxRows, !!names) : undefined}>
        <Table $size={cellSize} aria-label={t.auction}>
          <thead>
            <tr>
              {order.map((seat) => (
                <Head key={seat} scope="col" $vul={isVulnerable(vul, seat)} $turn={turn === seat}>
                  {seatLetter[seat]}
                  {names?.[seat] && <HeadName>{names[seat]}</HeadName>}
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
      </Scroll>
      {explained && (
        <Explain $float={!!maxRows}>
          <CallLabel call={explained.call} onCard />：{explained.alert || t.alert}
        </Explain>
      )}
    </Box>
  )
}
