import { useId, useState } from 'react'
import styled from 'styled-components'
import { RANKS, rankLabel, SEATS, SUIT_SYMBOL, SUITS, type Card, type Seat } from '../../shared/cards.ts'
import type { Range } from '../../shared/dealer.ts'
import { formatHand, parseHand } from '../../shared/pbn.ts'
import { cardName } from '../lib/cards.ts'
import { SHAPE_CHOICES, type SeatForm, type SeatForms } from '../lib/practiceForm.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { Input, Muted, Select } from './ui.tsx'

/**
 * Each seat's conditions in the practice dialog (`e10-t16`): a tab a seat, and on it the points,
 * a shape shortcut and the suit lengths, or the whole hand, typed (`AKQ2.K73.9.AJ852`) or clicked
 * card by card. A card another seat was given cannot be clicked. What the conditions mean and
 * whether they can be met is the dealer's (`shared/dealer.ts`); the server checks them again.
 */

const Box = styled.div`
  display: grid;
  gap: 12px;
  padding: 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

const Tabs = styled.div`
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
`

const Tab = styled.button<{ $active: boolean; $set: boolean }>`
  min-height: 32px;
  padding: 0 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme, $active }) => ($active ? theme.colors.primary : theme.colors.borderStrong)};
  background: ${({ theme, $active }) => ($active ? theme.colors.primary : theme.colors.surface)};
  color: ${({ theme, $active }) => ($active ? theme.colors.onPrimary : theme.colors.text)};
  font-weight: ${({ $set }) => ($set ? 700 : 400)};
  cursor: pointer;
`

const Panel = styled.div`
  display: grid;
  gap: 12px;
`

const Modes = styled.div`
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 14px;

  & > label {
    display: flex;
    align-items: center;
    gap: 6px;
  }
`

const RangeRow = styled.div`
  display: grid;
  grid-template-columns: minmax(64px, auto) 72px auto 72px;
  align-items: center;
  gap: 6px;
  font-size: 14px;

  & > input { width: 72px; }
`

const Row = styled.label`
  display: grid;
  grid-template-columns: minmax(64px, auto) 1fr;
  align-items: center;
  gap: 6px;
  font-size: 14px;
`

const Lengths = styled.details`
  font-size: 14px;

  & > summary { cursor: pointer; margin-bottom: 8px; }
  & > div { display: grid; gap: 8px; }
`

const Picker = styled.div`
  display: grid;
  gap: 4px;
`

const SuitRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;

  & > span {
    width: 18px;
    font-family: ${({ theme }) => theme.fonts.symbols};
  }
`

const Pick = styled.button<{ $suit: string }>`
  min-width: 26px;
  height: 28px;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid ${({ theme }) => theme.colors.borderStrong};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme, $suit }) => theme.suits[$suit as 'S']};
  font-size: 13px;
  cursor: pointer;

  &[aria-pressed='true'] {
    background: ${({ theme }) => theme.colors.primary};
    border-color: ${({ theme }) => theme.colors.primary};
    color: ${({ theme }) => theme.colors.onPrimary};
  }
  &:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
`

const Bad = styled.p`
  margin: 0;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.danger};
`

export function PracticeConditions({ forms, onChange }: { forms: SeatForms; onChange: (forms: SeatForms) => void }) {
  const t = useT()
  const [seat, setSeat] = useState<Seat>('S')
  const panelId = useId()
  const form = forms[seat]
  const set = (next: Partial<SeatForm>) => onChange({ ...forms, [seat]: { ...form, ...next } })
  // The cards the other seats were given: not this one's to pick
  const taken = new Set(
    SEATS.flatMap((other) => (other !== seat && forms[other].mode === 'hand' ? (parseHand(forms[other].hand, null) ?? []) : [])),
  )
  // Nothing typed yet is no card yet
  const mine = form.hand.trim() === '' ? [] : parseHand(form.hand, null)
  const toggle = (card: Card) => {
    const cards = mine ?? []
    const next = cards.includes(card) ? cards.filter((c) => c !== card) : [...cards, card]
    set({ hand: formatHand(next) })
  }
  const narrowed = (s: Seat) => {
    const f = forms[s]
    return f.mode === 'hand' || f.shape !== 'any' || f.hcp[0] > 0 || f.hcp[1] < 37 || SUITS.some((x) => f.lengths[x][0] > 0 || f.lengths[x][1] < 13)
  }

  const range = (label: string, value: Range, max: number, change: (next: Range) => void) => (
    <RangeRow>
      <span>{label}</span>
      <Input
        type="number"
        $size="sm"
        min={0}
        max={max}
        value={value[0]}
        aria-label={`${label} ${t.practiceFrom}`}
        onChange={(event) => change([clamp(event.target.valueAsNumber, max), value[1]])}
      />
      <span aria-hidden>–</span>
      <Input
        type="number"
        $size="sm"
        min={0}
        max={max}
        value={value[1]}
        aria-label={`${label} ${t.practiceTo}`}
        onChange={(event) => change([value[0], clamp(event.target.valueAsNumber, max)])}
      />
    </RangeRow>
  )

  return (
    <Box>
      <Tabs role="tablist" aria-label={t.practiceSeatLegend}>
        {SEATS.map((s) => (
          <Tab
            key={s}
            type="button"
            role="tab"
            aria-selected={s === seat}
            aria-controls={panelId}
            $active={s === seat}
            $set={narrowed(s)}
            onClick={() => setSeat(s)}
          >
            {t.seatNames[s]}
            {narrowed(s) && ' •'}
          </Tab>
        ))}
      </Tabs>
      <Panel id={panelId} role="tabpanel" aria-label={t.seatNames[seat]}>
        <Modes role="radiogroup" aria-label={t.seatNames[seat]}>
          {(['conditions', 'hand'] as const).map((mode) => (
            <label key={mode}>
              <input type="radio" name={`mode-${seat}`} checked={form.mode === mode} onChange={() => set({ mode })} />
              {t.practiceSeatModes[mode]}
            </label>
          ))}
        </Modes>
        {form.mode === 'conditions' ? (
          <>
            {range(t.practiceHcp, form.hcp, 37, (hcp) => set({ hcp }))}
            <Row>
              <span>{t.practiceShape}</span>
              <Select $size="sm" value={form.shape} onChange={(event) => set({ shape: event.target.value as SeatForm['shape'] })}>
                {SHAPE_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>
                    {t.practiceShapes[choice]}
                  </option>
                ))}
              </Select>
            </Row>
            <Lengths open={SUITS.some((x) => form.lengths[x][0] > 0 || form.lengths[x][1] < 13) || undefined}>
              <summary>{t.practiceSuitLengths}</summary>
              <div>
                {SUITS.map((suit) => (
                  <div key={suit}>
                    {range(t.practiceLength(SUIT_SYMBOL[suit]), form.lengths[suit], 13, (r) =>
                      set({ lengths: { ...form.lengths, [suit]: r } }),
                    )}
                  </div>
                ))}
              </div>
            </Lengths>
          </>
        ) : (
          <>
            <Row>
              <span>{t.practiceHandInput}</span>
              <Input
                $size="sm"
                value={form.hand}
                placeholder="AKQ2.K73.9.AJ852"
                aria-invalid={!parseHand(form.hand)}
                spellCheck={false}
                autoCapitalize="characters"
                onChange={(event) => set({ hand: event.target.value })}
              />
            </Row>
            <Muted>{t.practiceHandHint}</Muted>
            <Picker role="group" aria-label={t.practiceHandInput}>
              {SUITS.map((suit) => (
                <SuitRow key={suit}>
                  <span aria-hidden>{SUIT_SYMBOL[suit]}</span>
                  {[...RANKS].map((rank) => {
                    const card = suit + rank
                    const chosen = !!mine?.includes(card)
                    const full = !chosen && (mine?.length ?? 0) >= 13
                    return (
                      <Pick
                        key={card}
                        type="button"
                        $suit={suit}
                        aria-pressed={chosen}
                        aria-label={cardName(card, t)}
                        title={taken.has(card) ? t.practiceCardTaken : undefined}
                        disabled={taken.has(card) || full || mine === null}
                        onClick={() => toggle(card)}
                      >
                        {rankLabel(rank)}
                      </Pick>
                    )
                  })}
                </SuitRow>
              ))}
            </Picker>
            {mine === null ? <Bad role="alert">{t.practiceHandBad}</Bad> : <Muted>{t.practiceHandCount(mine.length)}</Muted>}
          </>
        )}
      </Panel>
    </Box>
  )
}

const clamp = (value: number, max: number) => (Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : 0)
