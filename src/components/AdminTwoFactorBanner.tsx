import { ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { mustTurnOnTwoFactor, TWO_FACTOR_ANCHOR } from '../lib/twoFactor.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button } from './ui.tsx'

/**
 * Admins must turn two-step sign-in on before admin features work (社長 2026-11-02, ARCHITECTURE.md
 * §5.2). The server refuses every admin-only request with `adminTwoFactorRequired` until then; this
 * banner tells the admin why and sends them to the account page's card. Nothing when it is on
 */

const Box = styled.section`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: ${({ theme }) => theme.space(3)};
  align-items: start;
  padding: ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.accent};
  border-left-width: 4px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.accentSoft};
  color: ${({ theme }) => theme.colors.text};
`

const Icon = styled(ShieldAlert)`
  color: ${({ theme }) => theme.colors.accentStrong};
`

const Body = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  justify-items: start;
`

const Title = styled.h2`
  margin: 0;
  font-size: ${({ theme }) => theme.type.h3.size};
  line-height: ${({ theme }) => theme.type.h3.line};
`

const Text = styled.p`
  margin: 0;
`

export function AdminTwoFactorBanner() {
  const { t } = usePreferences()
  const { user } = useAuth()
  if (!mustTurnOnTwoFactor(user)) return null
  const s = t.twoFactor
  return (
    <Box role="alert" aria-label={s.bannerTitle}>
      <Icon aria-hidden size={24} />
      <Body>
        <Title>{s.bannerTitle}</Title>
        <Text>{s.bannerBody}</Text>
        <Button as={Link} to={`/account#${TWO_FACTOR_ANCHOR}`} $variant="primary">
          {s.bannerAction}
        </Button>
      </Body>
    </Box>
  )
}
