import { callText, PASSED_OUT } from '../lib/calls.ts'
import styled from 'styled-components'
import { isBid, levelOf, strainOf, type Call, type Contract } from '../../shared/auction.ts'
import { SUIT_SYMBOL, type Strain, type Suit } from '../../shared/cards.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { useT } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'

/**
 * The only way suits, calls and contracts are drawn. `onCard` picks the card colours (fixed, on
 * white) instead of the chrome colours that follow the theme. Both follow the two- or four-colour
 * deck setting (X1).
 */

const Symbol = styled.span<{ $suit: Suit; $onCard?: boolean }>`
  color: ${({ theme, $suit, $onCard }) => ($onCard ? theme.cardSuits : theme.textSuits)[$suit]};
  font-family: ${({ theme }) => theme.fonts.symbols};
`

export function SuitSymbol({ suit, onCard }: { suit: Strain; onCard?: boolean }) {
  const t = useT()
  if (suit === 'N') return <span>NT</span>
  return (
    <Symbol $suit={suit} $onCard={onCard} role="img" aria-label={t.suitNames[suit]}>
      {SUIT_SYMBOL[suit]}
    </Symbol>
  )
}

const Tinted = styled.span<{ $suit: Suit; $onCard?: boolean }>`
  color: ${({ theme, $suit, $onCard }) => ($onCard ? theme.cardSuits : theme.textSuits)[$suit]};
  font-family: ${({ theme }) => theme.fonts.symbols};
`

const SUIT_OF_SYMBOL: Record<string, Suit> = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' }

/**
 * Words with suit symbols in them (a call's explanation, an alert, the handbook's words), the
 * symbols in the suit colours of the deck setting. The text itself is unchanged, so a screen
 * reader reads it as before; `onCard` is for the table's white panels (the card colours)
 */
export function SuitText({ text, onCard }: { text: string; onCard?: boolean }) {
  const parts = text.split(/([♠♥♦♣])/u)
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <Tinted key={i} $suit={SUIT_OF_SYMBOL[part]} $onCard={onCard}>
            {part}
          </Tinted>
        ) : (
          part
        ),
      )}
    </>
  )
}

/** '1S' → 1♠, 'P' → Pass, 'X' → X */
export function CallLabel({ call, onCard }: { call: Call; onCard?: boolean }) {
  if (!isBid(call)) return <span>{callText(call)}</span>
  return (
    <span>
      {levelOf(call)}
      <SuitSymbol suit={strainOf(call)} onCard={onCard} />
    </span>
  )
}

/** 4♠X S, or -- when all four passed: bridge shorthand, the same in every language */
export function ContractLabel({ contract, onCard }: { contract: Contract | null; onCard?: boolean }) {
  if (!contract) return <span>{PASSED_OUT}</span>
  return (
    <span>
      {contract.level}
      <SuitSymbol suit={contract.strain} onCard={onCard} />
      {contract.doubled} {seatLetter[contract.declarer]}
    </span>
  )
}

/** The contract and how it went: 4♥ S +1, 3NT N =, 2♠ E -2, -- (passed out) */
export function ContractResult({ contract, tricks, onCard }: { contract: Contract | null; tricks: number; onCard?: boolean }) {
  if (!contract) return <span>{PASSED_OUT}</span>
  return (
    <span>
      <ContractLabel contract={contract} onCard={onCard} /> {resultLabel(contract, tricks)}
    </span>
  )
}
