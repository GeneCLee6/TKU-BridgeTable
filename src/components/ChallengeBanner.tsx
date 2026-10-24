import { Swords } from 'lucide-react'
import styled from 'styled-components'
import type { TableChallenge } from '../../shared/protocol.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'

/** The title of a challenge table (`e7-t15`): which board of how many, and the deadline */

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

export function ChallengeBanner({ challenge }: { challenge: TableChallenge }) {
  const t = useT()
  const { lang } = usePreferences()
  // Before the first deal the next board is the one after those played
  const seq = challenge.seq || Math.min(challenge.played + 1, challenge.boards)
  return (
    <Wrap>
      <Swords size={15} aria-hidden />
      <span>{t.challengeBoard(seq, challenge.boards)}</span>
      <small>{t.challengeDeadline(formatDateTime(challenge.deadline, lang))}</small>
    </Wrap>
  )
}
