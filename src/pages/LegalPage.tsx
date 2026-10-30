import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { formatDate } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 隱私權政策 and 使用條款 (e11-t27, AC-11.10): open to anyone, signed in or not, so the sign-in page
 * can link to them. The text is in `strings.ts` (`legal`); a change to what they promise changes
 * `LEGAL_UPDATED` too
 */

/** When the policy and the terms last changed (Taiwan date) */
const LEGAL_UPDATED = Date.UTC(2026, 9, 30, 4)

const Article = styled.article`
  display: grid;
  gap: ${({ theme }) => theme.space(5)};
  max-width: 720px;

  & h2 {
    margin: 0 0 ${({ theme }) => theme.space(2)};
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h2.size};
    line-height: ${({ theme }) => theme.type.h2.line};
  }
  & p {
    margin: 0;
    color: ${({ theme }) => theme.colors.text};
    line-height: 1.7;
  }
`

const Links = styled.nav`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(4)};
  margin-top: ${({ theme }) => theme.space(8)};
`

export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { t, lang } = usePreferences()
  const l = t.legal
  const sections = kind === 'privacy' ? l.privacy : l.terms
  return (
    <PageMain>
      <PageTitle>{kind === 'privacy' ? l.privacyTitle : l.termsTitle}</PageTitle>
      <Article>
        <Muted>{l.updated(formatDate(LEGAL_UPDATED, lang))}</Muted>
        {sections.map((section) => (
          <section key={section.h}>
            <h2>{section.h}</h2>
            <p>{section.p}</p>
          </section>
        ))}
      </Article>
      <Links>
        {kind === 'privacy' ? <Link to="/terms">{l.termsTitle}</Link> : <Link to="/privacy">{l.privacyTitle}</Link>}
        <Link to="/">{l.home}</Link>
      </Links>
    </PageMain>
  )
}
