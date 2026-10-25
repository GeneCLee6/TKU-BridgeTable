import { useEffect, useId, useRef, useState } from 'react'
import styled from 'styled-components'
import { SUIT_SYMBOL, SUITS, type Suit } from '../../shared/cards.ts'
import type { DealConditions, Range, SeatConditions } from '../../shared/dealer.ts'
import { DEFAULT_PRACTICE_SETTINGS, PRACTICE_DEALS, type PracticeSettings } from '../../shared/practice.ts'
import { ROBOT_KINDS } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { Backdrop, Buttons, Choice, Group, Panel } from './TableSettingsDialog.tsx'
import { Button, Input, Muted } from './ui.tsx'

/**
 * Opening a practice table (`e10-t04`, AC-10.2): which hands to deal (a preset or the member's own
 * conditions for South and North), which TKB to play with, and Just Declare. The server checks it
 * all again (`parsePracticeSettings`) and says when the conditions cannot be met
 */

const Wide = styled(Panel)`
  max-width: 480px;
`

const Choices = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
`

const Conditions = styled.div`
  display: grid;
  gap: 12px;
  padding: 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};

  & > h3 {
    margin: 0;
    font-size: 15px;
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

const Check = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
`

/** What the custom form holds for one seat; lengths only for South */
interface SeatForm {
  hcp: Range
  balanced: boolean
  lengths: Record<Suit, Range>
}

const ANY_HCP: Range = [0, 37]
const ANY_LENGTH: Range = [0, 13]
const emptySeat = (hcp: Range = ANY_HCP): SeatForm => ({
  hcp,
  balanced: false,
  lengths: { S: ANY_LENGTH, H: ANY_LENGTH, D: ANY_LENGTH, C: ANY_LENGTH },
})

const same = (a: Range, b: Range) => a[0] === b[0] && a[1] === b[1]

/** Only what was narrowed goes to the server */
function seatConditions(form: SeatForm): SeatConditions | null {
  const lengths = SUITS.filter((suit) => !same(form.lengths[suit], ANY_LENGTH))
  const seat: SeatConditions = {
    ...(!same(form.hcp, ANY_HCP) && { hcp: form.hcp }),
    ...(lengths.length > 0 && { lengths: Object.fromEntries(lengths.map((suit) => [suit, form.lengths[suit]])) }),
    ...(form.balanced && { balanced: true }),
  }
  return Object.keys(seat).length ? seat : null
}

function conditionsOf(south: SeatForm, north: SeatForm): DealConditions {
  const s = seatConditions(south)
  const n = seatConditions(north)
  return { seats: { ...(s && { S: s }), ...(n && { N: n }) } }
}

export function PracticeDialog({
  onSubmit,
  onClose,
}: {
  onSubmit: (settings: PracticeSettings) => void
  onClose: () => void
}) {
  const t = useT()
  const titleId = useId()
  const [settings, setSettings] = useState<PracticeSettings>(DEFAULT_PRACTICE_SETTINGS)
  const [south, setSouth] = useState<SeatForm>(() => emptySeat([12, 37]))
  const [north, setNorth] = useState<SeatForm>(() => emptySeat())
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => first.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Wide role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.practiceTitle}</h2>
        <Muted>{t.practiceIntro}</Muted>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit(settings.deal === 'custom' ? { ...settings, conditions: conditionsOf(south, north) } : settings)
          }}
        >
          <Group>
            <legend>{t.practiceDealLegend}</legend>
            <Choices>
              {PRACTICE_DEALS.map((deal, i) => (
                <Choice key={deal}>
                  <input
                    ref={i === 0 ? first : undefined}
                    type="radio"
                    name="deal"
                    checked={settings.deal === deal}
                    onChange={() => setSettings({ ...settings, deal })}
                  />
                  <span>{t.practiceDeals[deal].label}</span>
                  <Muted>{t.practiceDeals[deal].hint}</Muted>
                </Choice>
              ))}
            </Choices>
            {settings.deal !== 'random' && <Muted>{t.practiceSouthDeals}</Muted>}
          </Group>
          {settings.deal === 'custom' && (
            <Group>
              <Conditions>
                <h3>{t.practiceSouth}</h3>
                {range(t.practiceHcp, south.hcp, 37, (hcp) => setSouth({ ...south, hcp }))}
                {SUITS.map((suit) => (
                  <div key={suit}>
                    {range(t.practiceLength(SUIT_SYMBOL[suit]), south.lengths[suit], 13, (r) =>
                      setSouth({ ...south, lengths: { ...south.lengths, [suit]: r } }),
                    )}
                  </div>
                ))}
                <Check>
                  <input type="checkbox" checked={south.balanced} onChange={(e) => setSouth({ ...south, balanced: e.target.checked })} />
                  {t.practiceBalanced}
                </Check>
              </Conditions>
              <Conditions>
                <h3>{t.practiceNorth}</h3>
                {range(t.practiceHcp, north.hcp, 37, (hcp) => setNorth({ ...north, hcp }))}
                <Check>
                  <input type="checkbox" checked={north.balanced} onChange={(e) => setNorth({ ...north, balanced: e.target.checked })} />
                  {t.practiceBalanced}
                </Check>
              </Conditions>
            </Group>
          )}
          <Group>
            <legend>{t.practiceRobots}</legend>
            {ROBOT_KINDS.map((kind) => (
              <Choice key={kind}>
                <input
                  type="radio"
                  name="robotKind"
                  checked={settings.robotKind === kind}
                  onChange={() => setSettings({ ...settings, robotKind: kind })}
                />
                <span>{t.robots[kind]}</span>
              </Choice>
            ))}
          </Group>
          <Group>
            <Choice>
              <input
                type="checkbox"
                checked={settings.justDeclare}
                onChange={(event) => setSettings({ ...settings, justDeclare: event.target.checked })}
              />
              <span>{t.justDeclare}</span>
              <Muted>{t.justDeclareHint}</Muted>
            </Choice>
          </Group>
          <Buttons>
            <Button type="button" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" $variant="primary">
              {t.practiceOpen}
            </Button>
          </Buttons>
        </form>
      </Wide>
    </Backdrop>
  )
}

const clamp = (value: number, max: number) => (Number.isFinite(value) ? Math.max(0, Math.min(max, Math.round(value))) : 0)
