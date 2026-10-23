import { X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styled, { css } from 'styled-components'
import type { AuctionCall } from '../../shared/auction.ts'
import { isVulnerable, type Vulnerability } from '../../shared/board.ts'
import { nextSeat, type Seat } from '../../shared/cards.ts'
import { auctionBoxHeight, auctionCell } from '../lib/measure.ts'
import { useRobotRules } from '../lib/useRobotRules.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { CallLabel } from './Suit.tsx'

/**
 * The auction as a table, BBO style: four columns from the viewer's point of view (left-hand
 * opponent, partner, right-hand opponent, the viewer last), vulnerable seats with a red header,
 * the dealer's first call in the dealer's column and '?' where the next call goes. Alerted calls
 * are yellow; click one and its explanation opens in a small window next to it. With `maxRows` the
 * table keeps one fixed height from the first call to the last, as on BBO: a long auction scrolls
 * inside it (the header stays put, the latest round in view).
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
    `}
`

/** An alerted call: the whole cell is a button that opens the explanation */
const AlertButton = styled.button`
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  &[aria-expanded='true'] { box-shadow: inset 0 0 0 2px ${({ theme }) => theme.table.panelText}; }
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

/** The explanation of an alerted call, in a small window by the call, over everything else */
const Popup = styled.div`
  position: fixed;
  z-index: 50;
  width: max-content;
  max-width: min(300px, calc(100vw - 16px));
  border: 1px solid ${({ theme }) => theme.table.panelBorder};
  border-radius: 10px;
  overflow: hidden;
  background: ${({ theme }) => theme.table.panel};
  color: ${({ theme }) => theme.table.panelText};
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  font-family: ${({ theme }) => theme.fonts.body};
`

const PopupHead = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 12px;
  background: ${({ theme }) => theme.table.alert};
  font-weight: 700;

  & > strong { font-family: ${({ theme }) => theme.fonts.cards}; font-size: 18px; }
  & > span { flex: 1; font-size: 13px; opacity: 0.8; }
`

const PopupClose = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  &:hover { background: ${({ theme }) => theme.table.shade}; }
`

const PopupText = styled.p`
  margin: 0;
  padding: 10px 12px 12px;
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
`

/** The explanation window, placed under the call (above it when there is no room below) */
function AlertPopup({ call, anchor, who, onClose }: { call: AuctionCall; anchor: HTMLElement; who: string; onClose: () => void }) {
  const t = useT()
  const { lang } = usePreferences()
  // A 2/1 robot's call carries what it shows: explain it in the viewer's language (the stored
  // Traditional Chinese words until the rules have loaded)
  const rules = useRobotRules(!!call.meaning)
  const text = (call.meaning && rules ? rules.describe(call.meaning, lang) : call.alert) || t.noExplanation
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const at = anchor.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(at.left + at.width / 2 - box.width / 2, window.innerWidth - box.width - 8))
    const below = at.bottom + 6
    const top = below + box.height <= window.innerHeight - 8 ? below : Math.max(8, at.top - box.height - 6)
    setPlace({ left, top })
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [anchor, onClose])

  return createPortal(
    <Popup
      ref={ref}
      role="dialog"
      aria-label={t.alert}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <PopupHead>
        <strong>
          <CallLabel call={call.call} onCard />
        </strong>
        <span>
          {t.alert} · {who}
        </span>
        <PopupClose type="button" onClick={onClose} aria-label={t.close}>
          <X size={18} aria-hidden />
        </PopupClose>
      </PopupHead>
      <PopupText>{text}</PopupText>
    </Popup>,
    document.body,
  )
}

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
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null)
  const order: Seat[] = [nextSeat(viewer, 1), nextSeat(viewer, 2), nextSeat(viewer, 3), viewer]
  const offset = order.indexOf(dealer)
  const cells: (AuctionCall | 'turn' | null)[] = [...Array(offset).fill(null), ...auction]
  if (turn) cells.push('turn')
  const rows = Array.from({ length: Math.max(1, Math.ceil(cells.length / 4)) }, (_, r) => cells.slice(r * 4, r * 4 + 4))
  const explained = open ? auction[open.index] : undefined
  const closePopup = useCallback(() => setOpen(null), [])
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
                    <Cell key={c} $size={cellSize} $call={cell.call} $alert={alerted}>
                      {alerted ? (
                        <AlertButton
                          type="button"
                          aria-haspopup="dialog"
                          aria-expanded={open?.index === index}
                          onClick={(e) => setOpen(open?.index === index ? null : { index, anchor: e.currentTarget })}
                        >
                          <CallLabel call={cell.call} onCard />
                          <span className="visually-hidden">（{t.alert}）</span>
                        </AlertButton>
                      ) : (
                        <CallLabel call={cell.call} onCard />
                      )}
                    </Cell>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      </Scroll>
      {explained && open && (
        <AlertPopup
          call={explained}
          anchor={open.anchor}
          who={`${seatLetter[explained.seat]}${names?.[explained.seat] ? ` ${names[explained.seat]}` : ''}`}
          onClose={closePopup}
        />
      )}
    </Box>
  )
}
