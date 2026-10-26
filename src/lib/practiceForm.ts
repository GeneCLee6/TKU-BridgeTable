import { SEATS, SUIT_SYMBOL, SUITS, type Seat, type Suit } from '../../shared/cards.ts'
import type { DealConditions, Range, SeatConditions } from '../../shared/dealer.ts'
import { formatHand, parseHand } from '../../shared/pbn.ts'
import type { Strings } from '../strings.ts'

/**
 * What the practice dialog's form holds for each seat (`e10-t16`) and how it turns into the deal
 * conditions the server checks (`parsePracticeSettings`), and back (a saved setting applied). Pure:
 * the conditions themselves are checked again on the server.
 */

/** The shape shortcuts: each is one of the dealer's shape conditions */
export const SHAPE_CHOICES = ['any', 'balanced', '5332', '4432', '4441', 'shortness', 'five', 'six'] as const
export type ShapeChoice = (typeof SHAPE_CHOICES)[number]

const SHAPE_CONDITIONS: Record<ShapeChoice, SeatConditions> = {
  any: {},
  balanced: { balanced: true },
  '5332': { shapes: ['5332'] },
  '4432': { shapes: ['4432'] },
  '4441': { shapes: ['4441'] },
  shortness: { shortest: [0, 1] },
  five: { longest: [5, 13] },
  six: { longest: [6, 13] },
}

export interface SeatForm {
  /** Conditions, or the whole hand written out */
  mode: 'conditions' | 'hand'
  hcp: Range
  shape: ShapeChoice
  lengths: Record<Suit, Range>
  /** The hand as the member types it, `AKQ2.K73.9.AJ852` */
  hand: string
}

export type SeatForms = Record<Seat, SeatForm>

export const ANY_HCP: Range = [0, 37]
export const ANY_LENGTH: Range = [0, 13]

export const emptySeat = (hcp: Range = ANY_HCP): SeatForm => ({
  mode: 'conditions',
  hcp,
  shape: 'any',
  lengths: { S: ANY_LENGTH, H: ANY_LENGTH, D: ANY_LENGTH, C: ANY_LENGTH },
  hand: '',
})

/** A new form: South with an opening hand, the others anything */
export const emptyForms = (): SeatForms => ({ N: emptySeat(), E: emptySeat(), S: emptySeat([12, 37]), W: emptySeat() })

const same = (a: Range, b: Range) => a[0] === b[0] && a[1] === b[1]

/** Only what was narrowed goes to the server; a hand not written right yet gives nothing */
export function seatConditions(form: SeatForm): SeatConditions | null {
  if (form.mode === 'hand') {
    const hand = parseHand(form.hand)
    return hand ? { hand } : null
  }
  const lengths = SUITS.filter((suit) => !same(form.lengths[suit], ANY_LENGTH))
  const seat: SeatConditions = {
    ...(!same(form.hcp, ANY_HCP) && { hcp: form.hcp }),
    ...(lengths.length > 0 && { lengths: Object.fromEntries(lengths.map((suit) => [suit, form.lengths[suit]])) }),
    ...SHAPE_CONDITIONS[form.shape],
  }
  return Object.keys(seat).length ? seat : null
}

export function conditionsOf(forms: SeatForms): DealConditions {
  const seats: NonNullable<DealConditions['seats']> = {}
  for (const seat of SEATS) {
    const c = seatConditions(forms[seat])
    if (c) seats[seat] = c
  }
  return { seats }
}

/** The seats whose hand is being written but is not 13 cards written right */
export const badHands = (forms: SeatForms): Seat[] =>
  SEATS.filter((seat) => forms[seat].mode === 'hand' && !parseHand(forms[seat].hand))

const shapeChoiceOf = (c: SeatConditions): ShapeChoice =>
  SHAPE_CHOICES.find((choice) => {
    const wanted = SHAPE_CONDITIONS[choice]
    return (
      !!c.balanced === !!wanted.balanced &&
      (c.shapes ?? []).join() === (wanted.shapes ?? []).join() &&
      (c.longest ?? []).join() === (wanted.longest ?? []).join() &&
      (c.shortest ?? []).join() === (wanted.shortest ?? []).join()
    )
  }) ?? 'any'

/** The form for some conditions (a saved setting applied): what the form can say of them */
export function formsOf(conditions: DealConditions | undefined): SeatForms {
  if (!conditions) return emptyForms()
  const forms = {} as SeatForms
  for (const seat of SEATS) {
    const c = conditions.seats?.[seat]
    const form = emptySeat()
    if (c?.hand) forms[seat] = { ...form, mode: 'hand', hand: formatHand(c.hand) }
    else if (c)
      forms[seat] = {
        ...form,
        hcp: c.hcp ?? ANY_HCP,
        shape: shapeChoiceOf(c),
        lengths: { ...form.lengths, ...c.lengths },
      }
    else forms[seat] = form
  }
  return forms
}

/** What is wrong with the conditions, in words: `dealer.ts`'s `conditionsProblem` says where */
export function problemText(t: Strings, problem: string): string {
  const [where, what] = problem.split('.')
  if (problem === 'hands') return t.practiceProblems.hands
  if (problem === 'hcp') return t.practiceProblems.total
  if (where === 'lengths') return t.practiceProblems.suit(SUIT_SYMBOL[what as Suit] ?? what)
  if (where === 'NS' || where === 'EW') return t.practiceProblems.side(where)
  const seat = t.seatNames[where as Seat] ?? where
  const kind = what as 'hcp' | 'lengths' | 'shape' | 'hand'
  return (t.practiceProblems[kind] ?? t.practiceProblems.shape)(seat)
}
