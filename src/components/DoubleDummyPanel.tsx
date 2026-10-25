import styled from 'styled-components'
import type { Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { TABLE_STRAINS, type ParContract } from '../lib/doubleDummy.ts'
import { signed } from '../lib/format.ts'
import { useDoubleDummy } from '../lib/useDoubleDummy.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { SuitSymbol } from './Suit.tsx'
import { Muted } from './ui.tsx'

/**
 * The DD table (tricks each seat takes as declarer in each strain, BBO's layout: N S E W down,
 * NT ♠ ♥ ♦ ♣ across) and the par of a finished board, solved in the browser (`e4-t34`).
 */

/** Partners next to each other, as BBO lists them */
const ROWS: readonly Seat[] = ['N', 'S', 'E', 'W']

const Table = styled.table`
  border-collapse: collapse;
  font-size: 15px;
  text-align: center;
  font-variant-numeric: tabular-nums;

  th, td { padding: 4px 10px; border-bottom: 1px solid ${({ theme }) => theme.colors.border}; }
  th { color: ${({ theme }) => theme.colors.textMuted}; font-weight: 600; }
  td { font-weight: 700; }
  td[data-down] { color: ${({ theme }) => theme.colors.textMuted}; font-weight: 400; }
`

const Par = styled.p`
  margin: 10px 0 0;
  font-size: 15px;

  & > strong { margin-right: 8px; }
`

const Footnote = styled.p`
  margin: 8px 0 0;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.textMuted};

  a { color: ${({ theme }) => theme.colors.textMuted}; }
`

function ParLabel({ contract }: { contract: ParContract }) {
  return (
    <span>
      {contract.level}
      <SuitSymbol suit={contract.strain} />
      {contract.doubled && 'X'} {contract.by}
      {contract.overtricks !== 0 && ` ${signed(contract.overtricks)}`}
    </span>
  )
}

export function DoubleDummyPanel({ board }: { board: BoardState }) {
  const { t } = usePreferences()
  const state = useDoubleDummy(board)

  if (state.status === 'unavailable') return null
  if (state.status === 'loading') return <Muted role="status">{t.ddLoading}</Muted>
  if (state.status === 'error') return <Muted role="alert">{t.ddFailed}</Muted>

  const { table, par } = state.analysis
  return (
    <div>
      <Table aria-label={t.ddTable}>
        <thead>
          <tr>
            <th aria-label={t.declarer} />
            {TABLE_STRAINS.map((strain) => (
              <th key={strain} scope="col">
                <SuitSymbol suit={strain} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((seat) => (
            <tr key={seat}>
              <th scope="row">{seatLetter[seat]}</th>
              {TABLE_STRAINS.map((strain) => {
                const tricks = table[strain][seat]
                return (
                  <td key={strain} data-down={tricks < 7 ? '' : undefined}>
                    {tricks}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      <Par>
        <strong>{t.par}</strong>
        {par.contracts.length === 0 ? (
          t.parPassOut
        ) : (
          <>
            NS {signed(par.scoreNS)} ·{' '}
            {par.contracts.map((contract, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <ParLabel contract={contract} />
              </span>
            ))}
          </>
        )}
      </Par>
      <Footnote>
        {t.ddNote}{' '}
        <a href="/licenses/dds-apache-2.0.txt" target="_blank" rel="noopener">
          DDS · Apache-2.0
        </a>
      </Footnote>
    </div>
  )
}
