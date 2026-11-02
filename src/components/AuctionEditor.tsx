import { useId } from 'react'
import styled from 'styled-components'
import { seatToCall } from '../../shared/auction.ts'
import type { Vulnerability } from '../../shared/board.ts'
import { SEATS, type Seat } from '../../shared/cards.ts'
import type { ForumAuction } from '../../shared/forum.ts'
import { addCall, auctionStatus, emptyAuction, nextCalls, undoCall, withDealer } from '../../shared/forum-editor.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { AuctionBox } from './AuctionBox.tsx'
import { BiddingBox } from './BiddingBox.tsx'
import { ContractLabel } from './Suit.tsx'
import { Button, FieldLabel, Muted, Select } from './ui.tsx'

/**
 * 叫牌過程輸入 (E13 K2, `e13-t06`): the table's own bidding box (`BiddingBox`, with Alert and the
 * keyboard) under the auction as the record pages draw it (`AuctionBox`). The box offers only the
 * calls `shared/auction.ts` allows next (`nextCalls`), so the auction is always legal; a call can
 * be taken back. The dealer may change at any time: the calls keep their order and move seats with
 * it. An auction may stop halfway (a bidding problem); once it is over the box goes away and the
 * contract is shown. Keep one of these on a page at a time: the bidding box listens to the keyboard.
 */

const Wrap = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
  justify-items: start;
`

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: ${({ theme }) => theme.space(3)};

  & > label {
    display: grid;
    gap: 4px;
  }
`

const BoxSlot = styled.div`
  width: 100%;
  max-width: 420px;
`

export function AuctionEditor({
  value,
  onChange,
  vul = 'None',
}: {
  value: ForumAuction
  onChange: (auction: ForumAuction) => void
  /** From four hands in the same post, for the auction's colours */
  vul?: Vulnerability
}) {
  const { t } = usePreferences()
  const e = t.forumEditor
  const dealerId = useId()
  const legal = nextCalls(value)
  const { over, contract } = auctionStatus(value)
  const turn = over ? null : seatToCall(value.dealer, value.calls.length)

  return (
    <Wrap>
      <Controls>
        <label htmlFor={dealerId}>
          <FieldLabel as="span">{e.dealer}</FieldLabel>
          <Select id={dealerId} $size="sm" value={value.dealer} onChange={(ev) => onChange(withDealer(value, ev.target.value as Seat))}>
            {SEATS.map((s) => (
              <option key={s} value={s}>
                {t.seatNames[s]}
              </option>
            ))}
          </Select>
        </label>
        <Button type="button" $variant="secondary" $size="sm" disabled={!value.calls.length} onClick={() => onChange(undoCall(value))}>
          {e.undo}
        </Button>
        <Button type="button" $variant="ghost" $size="sm" disabled={!value.calls.length} onClick={() => onChange(emptyAuction(value.dealer))}>
          {e.clearAuction}
        </Button>
      </Controls>
      <AuctionBox auction={value.calls} dealer={value.dealer} vul={vul} turn={turn} size={40} />
      <Muted role="status">
        {!value.calls.length && e.noCalls}
        {value.calls.length > 0 && !over && `${e.nextToCall(t.seatNames[turn!])} · ${e.auctionRunning}`}
        {over && !contract && `${e.auctionOver}${e.passedOut}`}
        {over && contract && (
          <>
            {e.auctionOver}
            <ContractLabel contract={contract} /> {e.by(t.seatNames[contract.declarer])}
          </>
        )}
      </Muted>
      {legal.length > 0 && (
        <BoxSlot>
          <BiddingBox legal={legal} onCall={(call, alert) => onChange(addCall(value, call, alert))} size={44} />
        </BoxSlot>
      )}
    </Wrap>
  )
}
