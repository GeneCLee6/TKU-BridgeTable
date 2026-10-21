import styled from 'styled-components'
import { isBid, levelOf, strainOf, type Call, type Contract } from '../../shared/auction.ts'
import { SUIT_SYMBOL, type Strain, type Suit } from '../../shared/cards.ts'
import { seatLetter, strings } from '../strings.ts'

/**
 * The only way suits, calls and contracts are drawn. `$onCard` picks the card colours (fixed, on
 * white) instead of the chrome colours that follow the theme.
 */

const Symbol = styled.span<{ $suit: Suit; $onCard?: boolean }>`
  color: ${({ theme, $suit, $onCard }) => ($onCard ? theme.cardSuits : theme.suits)[$suit]};
  font-family: ${({ theme }) => theme.fonts.symbols};
`

const SUIT_NAME: Record<Strain, string> = { S: '黑桃', H: '紅心', D: '方塊', C: '梅花', N: '無王' }

export function SuitSymbol({ suit, onCard }: { suit: Strain; onCard?: boolean }) {
  if (suit === 'N') return <span>NT</span>
  return (
    <Symbol $suit={suit} $onCard={onCard} role="img" aria-label={SUIT_NAME[suit]}>
      {SUIT_SYMBOL[suit]}
    </Symbol>
  )
}

/** '1S' → 1♠, 'P' → Pass, 'X' → X */
export function CallLabel({ call, onCard }: { call: Call; onCard?: boolean }) {
  if (!isBid(call)) return <span>{strings.callNames[call] === 'Pass' ? 'Pass' : call}</span>
  return (
    <span>
      {levelOf(call)}
      <SuitSymbol suit={strainOf(call)} onCard={onCard} />
    </span>
  )
}

/** 4♠X S */
export function ContractLabel({ contract, onCard }: { contract: Contract | null; onCard?: boolean }) {
  if (!contract) return <span>{strings.passedOut}</span>
  return (
    <span>
      {contract.level}
      <SuitSymbol suit={contract.strain} onCard={onCard} />
      {contract.doubled} {seatLetter[contract.declarer]}
    </span>
  )
}
