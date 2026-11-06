import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { defaultRobotKind, isRobotKind, ROBOT_KINDS } from '../../shared/protocol.ts'
import { SystemCardView } from '../components/SystemCardView.tsx'
import { Button, PageMain, PageTitle } from '../components/ui.tsx'
import { mayReadCard } from '../lib/systemCards.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 制度卡 (e5-t52, AC-5.11): the cards of the systems TKB bids, one address each so a table can
 * link to one in a new tab. Without a system in the address, the one TKB is seated in by default.
 * The club's card is offered only to those the server gives it to; for others the page falls back to the 2/1 card.
 */

const Choices = styled.nav`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
`

export function SystemCardPage() {
  const { t } = usePreferences()
  const { user } = useAuth()
  const { system } = useParams()
  const kinds = ROBOT_KINDS.filter((kind) => mayReadCard(kind, user))
  const wanted = isRobotKind(system) ? system : defaultRobotKind(user)
  const current = kinds.includes(wanted) ? wanted : 'gib'
  return (
    <PageMain>
      <PageTitle>{t.systemCard.title}</PageTitle>
      <Choices aria-label={t.systemCard.title}>
        {kinds.map((kind) => (
          <Button
            key={kind}
            as={Link}
            to={`/system-card/${kind}`}
            $variant={kind === current ? 'primary' : 'secondary'}
            aria-current={kind === current ? 'page' : undefined}
          >
            {t.robotSystems[kind]}
          </Button>
        ))}
      </Choices>
      <SystemCardView system={current} />
    </PageMain>
  )
}
