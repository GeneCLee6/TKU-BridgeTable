import { useId, useState } from 'react'
import styled from 'styled-components'
import type { Vulnerability } from '../../shared/board.ts'
import { RANKS, rankLabel, SEATS, SUITS, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import type { ForumDeal as ForumDealValue } from '../../shared/forum.ts'
import {
  dealStatus,
  emptyHands,
  fillRemaining,
  HAND_SIZE,
  lastSeatToFill,
  ownerOf,
  seatToFill,
  toggleCard,
  unassignedCards,
  VULNERABILITIES,
} from '../../shared/forum-editor.ts'
import { cardName } from '../lib/cards.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { ForumDeal } from './ForumBlocks.tsx'
import { SuitSymbol } from './Suit.tsx'
import { Button, FieldLabel, Muted, Select } from './ui.tsx'

/**
 * 四手牌編輯器 (E13 K2, `e13-t05`): choose a seat, then click cards to give them to it. A card the
 * seat holds goes back; one another seat holds moves; a seat with 13 takes no more, and the next
 * seat clockwise that is short is chosen. When three hands are full the rest can go to the fourth
 * at once. The dealer and vulnerability are chosen below, and the deal is drawn as the post will
 * show it (`ForumDeal`, the record pages' diagram). A partial deal is allowed (`dealStatus`).
 */

const Wrap = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
`

const Seats = styled.fieldset`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  margin: 0;
  padding: 0;
  border: 0;

  & > legend {
    float: left;
    margin-right: ${({ theme }) => theme.space(2)};
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 14px;
  }
`

const SeatButton = styled.button<{ $on: boolean }>`
  min-width: 64px;
  padding: 6px 10px;
  border: 1px solid ${({ theme, $on }) => ($on ? theme.colors.primary : theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $on }) => ($on ? theme.colors.primarySoft : theme.colors.surface)};
  color: ${({ theme }) => theme.colors.text};
  font-weight: ${({ $on }) => ($on ? 700 : 400)};
  font-variant-numeric: tabular-nums;
  cursor: pointer;
`

const Grid = styled.div`
  display: grid;
  gap: 4px;
  overflow-x: auto;
`

const SuitRow = styled.div`
  display: grid;
  grid-template-columns: 24px repeat(13, minmax(30px, 1fr));
  gap: 3px;
  align-items: center;
  min-width: 440px;
`

const CardKey = styled.button<{ $suit: Suit; $held: boolean; $mine: boolean }>`
  position: relative;
  height: 40px;
  padding: 0;
  border: 1px solid ${({ theme, $mine }) => ($mine ? theme.colors.primary : theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $held, $mine }) => ($mine ? theme.colors.primarySoft : $held ? theme.colors.surfaceAlt : theme.colors.surface)};
  color: ${({ theme, $suit, $held, $mine }) => ($held && !$mine ? theme.colors.textMuted : theme.suits[$suit])};
  font-weight: 700;
  cursor: pointer;

  & > small {
    position: absolute;
    right: 2px;
    bottom: 1px;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 10px;
    font-weight: 600;
  }
  &:disabled {
    cursor: not-allowed;
  }
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

export function DealEditor({ value, onChange }: { value: ForumDealValue; onChange: (deal: ForumDealValue) => void }) {
  const { t } = usePreferences()
  const e = t.forumEditor
  const dealerId = useId()
  const vulId = useId()
  const [seat, setSeat] = useState<Seat>(() => seatToFill(value.hands, 'N'))
  const hands = value.hands
  const last = lastSeatToFill(hands)
  const left = unassignedCards(hands).length
  const status = dealStatus(value)

  const toggle = (card: Card) => {
    const next = toggleCard(hands, seat, card)
    if (next === hands) return
    onChange({ ...value, hands: next })
    if (next[seat].length === HAND_SIZE && next[seat].length > hands[seat].length) setSeat(seatToFill(next, seat))
  }

  return (
    <Wrap>
      <Seats>
        <legend>{e.seatToFill}</legend>
        {SEATS.map((s) => (
          <SeatButton key={s} type="button" $on={s === seat} aria-pressed={s === seat} onClick={() => setSeat(s)}>
            {e.seatCount(t.seatNames[s], hands[s].length)}
          </SeatButton>
        ))}
      </Seats>
      <Grid role="group" aria-label={e.cards}>
        {SUITS.map((suit) => (
          <SuitRow key={suit}>
            <SuitSymbol suit={suit} />
            {[...RANKS].map((rank) => {
              const card = `${suit}${rank}`
              const owner = ownerOf(hands, card)
              const name = cardName(card, t)
              const full = !owner && hands[seat].length >= HAND_SIZE
              return (
                <CardKey
                  key={card}
                  type="button"
                  $suit={suit}
                  $held={!!owner}
                  $mine={owner === seat}
                  aria-pressed={owner === seat}
                  aria-label={owner ? e.cardHeld(name, t.seatNames[owner]) : e.cardFree(name)}
                  disabled={full}
                  onClick={() => toggle(card)}
                >
                  {rankLabel(rank)}
                  {owner && <small aria-hidden>{seatLetter[owner]}</small>}
                </CardKey>
              )
            })}
          </SuitRow>
        ))}
      </Grid>
      <Controls>
        <label htmlFor={dealerId}>
          <FieldLabel as="span">{e.dealer}</FieldLabel>
          <Select id={dealerId} $size="sm" value={value.dealer} onChange={(ev) => onChange({ ...value, dealer: ev.target.value as Seat })}>
            {SEATS.map((s) => (
              <option key={s} value={s}>
                {t.seatNames[s]}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor={vulId}>
          <FieldLabel as="span">{e.vul}</FieldLabel>
          <Select id={vulId} $size="sm" value={value.vul} onChange={(ev) => onChange({ ...value, vul: ev.target.value as Vulnerability })}>
            {VULNERABILITIES.map((v) => (
              <option key={v} value={v}>
                {t.vulNames[v]}
              </option>
            ))}
          </Select>
        </label>
        {last && left > 0 && (
          <Button type="button" $variant="secondary" $size="sm" onClick={() => onChange({ ...value, hands: fillRemaining(hands) })}>
            {e.fillRest(t.seatNames[last], left)}
          </Button>
        )}
        <Button type="button" $variant="ghost" $size="sm" disabled={left === 52} onClick={() => onChange({ ...value, hands: emptyHands() })}>
          {e.clearDeal}
        </Button>
      </Controls>
      <Muted role="status">{status.complete ? e.complete : e.partial(status.missing)}</Muted>
      {left < 52 && <ForumDeal deal={value} />}
    </Wrap>
  )
}
