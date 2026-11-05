import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { defaultRobotKind, isRobotKind, ROBOT_KINDS } from '../../shared/protocol.ts'
import { SystemCardView } from '../components/SystemCardView.tsx'
import { Button, PageMain, PageTitle } from '../components/ui.tsx'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 制度卡 (e5-t52, AC-5.11): the cards of the two systems TKB bids, one address each so a table can
 * link to one in a new tab. Without a system in the address, the one TKB is seated in by default.
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
  const current = isRobotKind(system) ? system : defaultRobotKind(user)
  return (
    <PageMain>
      <PageTitle>{t.systemCard.title}</PageTitle>
      <Choices aria-label={t.systemCard.title}>
        {ROBOT_KINDS.map((kind) => (
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
