import { Dumbbell } from 'lucide-react'
import styled from 'styled-components'
import type { TablePractice } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'

/** The title of a practice table (`e10-t04`): how many boards dealt, which hands, which robots, Just Declare */

const Wrap = styled.span`
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;

  & > small {
    font-weight: 400;
    opacity: 0.85;
  }
`

export function PracticeBanner({ practice }: { practice: TablePractice }) {
  const t = useT()
  const details = [
    t.practiceDeals[practice.deal].label,
    t.robots[practice.robotKind],
    ...(practice.justDeclare ? [t.justDeclare] : []),
  ]
  return (
    <Wrap>
      <Dumbbell size={15} aria-hidden />
      <span>{t.practiceBoard(Math.max(1, practice.dealt))}</span>
      <small>{details.join(' · ')}</small>
    </Wrap>
  )
}
