import { Dumbbell } from 'lucide-react'
import styled from 'styled-components'
import type { TablePractice } from '../../shared/protocol.ts'
import { useT } from '../state/PreferencesContext.tsx'

/**
 * The title of a practice table (`e10-t04`): how many boards dealt, which hands (a deal set's
 * problem, `e10-t16`), which robots, Just Declare, the bidding practice, 顯示四家
 */

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
  const problem = practice.problem
  const details = [
    // A deal set (e10-t16): where from, and which problem of how many
    practice.set ? t.practiceSetSources[practice.set.source] : t.practiceDeals[practice.deal].label,
    ...(problem ? [t.practiceProblem(problem.seq, problem.count), ...(problem.title ? [problem.title] : [])] : []),
    t.robots[practice.robotKind],
    ...(practice.justDeclare ? [t.justDeclare] : []),
    ...(practice.biddingOnly ? [t.biddingOnly] : []),
    ...(practice.showHands ? [t.practiceShowHands] : []),
  ]
  return (
    <Wrap>
      <Dumbbell size={15} aria-hidden />
      <span>{t.practiceBoard(Math.max(1, practice.dealt))}</span>
      <small>{details.join(' · ')}</small>
    </Wrap>
  )
}
