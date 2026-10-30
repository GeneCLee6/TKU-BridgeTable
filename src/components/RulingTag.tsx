import styled from 'styled-components'
import type { ScoreRuling } from '../../shared/ruling-scoring.ts'
import { rulingLabel } from '../lib/rulings.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

const Tag = styled.small`
  display: block;
  font-weight: 600;
  color: ${({ theme }) => theme.colors.textMuted};
`

/**
 * 「裁定 Avg+ NS」under a score as played (`e2-t36`): the director's ruling the challenge standings
 * or the match score counted instead of it
 */
export function RulingTag({ ruling }: { ruling: ScoreRuling }) {
  const { t } = usePreferences()
  const label = rulingLabel(t, ruling)
  return (
    <Tag title={label}>
      {t.director.ruling} {label}
    </Tag>
  )
}
