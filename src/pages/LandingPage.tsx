import { BarChart3, Bot, Library, Swords, Trophy, Users, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { CLUB_APPLY_PAGE } from '../../shared/platform.ts'
import { OvertrickWordmark } from '../components/Logo.tsx'
import { currentClub } from '../lib/club.ts'
import { DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { useClubName } from '../lib/useClubName.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'

/**
 * The platform's landing page (e12-t13, `/about`): what Overtrick is, how a club joins, and the way
 * back to one's own club. Anyone may read it, signed in or not; it is the one page in English until
 * the visitor chooses a language (`App.tsx`). Every claim here is about something the site really
 * does: check the code before adding one. scripts/seo.ts gives crawlers these words as plain HTML.
 */

const Page = styled.main`
  color: ${({ theme }) => theme.colors.text};
`

const Hero = styled.section`
  display: grid;
  justify-items: start;
  gap: ${({ theme }) => theme.space(4)};
  padding: ${({ theme }) => theme.space(12)} max(16px, calc((100% - 928px) / 2));
  background: ${({ theme }) => theme.colors.header};
  color: ${({ theme }) => theme.colors.onHeader};

  ${mobile} {
    padding-top: ${({ theme }) => theme.space(8)};
    padding-bottom: ${({ theme }) => theme.space(8)};
  }

  & > h1 {
    margin: 0;
    font-size: clamp(30px, 6vw, 46px);
    line-height: 1.15;
  }
  & > p {
    max-width: 640px;
    margin: 0;
    color: ${({ theme }) => theme.colors.headerMuted};
    font-size: 18px;
    line-height: 1.6;
  }
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(3)};
  margin-top: ${({ theme }) => theme.space(2)};
`

const action = `
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
`

const PrimaryLink = styled.a`
  ${action}
  background: ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.header};
`

const SecondaryLink = styled(Link)`
  ${action}
  border: 1px solid ${({ theme }) => theme.colors.headerMuted};
  color: ${({ theme }) => theme.colors.onHeader};

  &:hover { background: ${({ theme }) => theme.colors.headerHover}; }
`

const Note = styled.small`
  color: ${({ theme }) => theme.colors.headerMuted};
  font-size: 14px;
`

const Body = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(10)};
  max-width: 960px;
  margin: 0 auto;
  padding: ${({ theme }) => theme.space(10)} 16px;

  & h2 {
    margin: 0 0 ${({ theme }) => theme.space(4)};
    font-size: ${({ theme }) => theme.type.h2.size};
    line-height: ${({ theme }) => theme.type.h2.line};
  }
  & p { margin: 0; line-height: 1.7; }
`

const Features = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: ${({ theme }) => theme.space(4)};
  margin: 0;
  padding: 0;
  list-style: none;
`

const Feature = styled.li`
  display: grid;
  align-content: start;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(4)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};

  & > svg { color: ${({ theme }) => theme.colors.accentStrong}; }
  & > h3 { margin: 0; font-size: 17px; }
  & > p { color: ${({ theme }) => theme.colors.textMuted}; }
`

const Steps = styled.ol`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  margin: 0 0 ${({ theme }) => theme.space(4)};
  padding-left: 22px;
  line-height: 1.7;
`

const Facts = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
  gap: ${({ theme }) => theme.space(6)};
`

const Footer = styled.footer`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(4)};
  padding-top: ${({ theme }) => theme.space(4)};
  border-top: 1px solid ${({ theme }) => theme.colors.border};
`

export function LandingPage() {
  const { user } = useAuth()
  const { t } = usePreferences()
  const clubName = useClubName()
  const l = t.landing
  // At the plain address the root is 淡江's sign-in page; at /c/<id>/ it is that club's
  const inClub = !!user || currentClub() !== DEFAULT_CLUB_ID
  const features: [LucideIcon, string, string][] = [
    [Users, l.tablesH, l.tablesP],
    [Bot, l.robotsH, l.robotsP],
    [BarChart3, l.analysisH, l.analysisP],
    [Library, l.recordsH, l.recordsP],
    [Swords, l.challengesH, l.challengesP],
    [Trophy, l.matchesH, l.matchesP],
  ]
  return (
    <Page>
      <Hero>
        {inClub && <OvertrickWordmark height={30} />}
        <h1>{l.headline}</h1>
        <p>{l.lead}</p>
        <Actions>
          <PrimaryLink href={CLUB_APPLY_PAGE}>{l.apply}</PrimaryLink>
          <SecondaryLink to="/">{inClub ? l.backTo(clubName) : l.signIn}</SecondaryLink>
        </Actions>
        {!inClub && <Note>{l.signInOther}</Note>}
      </Hero>
      <Body>
        <section>
          <h2>{l.featuresTitle}</h2>
          <Features>
            {features.map(([Icon, heading, text]) => (
              <Feature key={heading}>
                <Icon size={24} aria-hidden />
                <h3>{heading}</h3>
                <p>{text}</p>
              </Feature>
            ))}
          </Features>
        </section>
        <section>
          <h2>{l.joinTitle}</h2>
          <Steps>
            {l.joinSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </Steps>
          <a href={CLUB_APPLY_PAGE}>{l.joinCta}</a>
        </section>
        <Facts>
          <section>
            <h2>{l.freeTitle}</h2>
            <p>{l.freeP}</p>
          </section>
          <section>
            <h2>{l.whoTitle}</h2>
            <p>{l.whoP}</p>
          </section>
        </Facts>
        <Footer>
          <Link to="/privacy">{t.legal.privacyTitle}</Link>
          <Link to="/terms">{t.legal.termsTitle}</Link>
        </Footer>
      </Body>
    </Page>
  )
}
