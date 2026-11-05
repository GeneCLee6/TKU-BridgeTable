import { ExternalLink, X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import styled from 'styled-components'
import { bookUrl } from '../../shared/book-site.ts'
import { rankLabel, SUIT_SYMBOL } from '../../shared/cards.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import type { CardGroup, CardSection } from '../../shared/robot/system/card.ts'
import { useRobotRules, type RobotRules } from '../lib/useRobotRules.ts'
import { systemCardUrl, useSystemCard } from '../lib/systemCards.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { panelScroll } from '../styles/controls.ts'
import { Backdrop } from './Modal.tsx'
import { CallLabel, SuitText } from './Suit.tsx'
import { Card, Muted } from './ui.tsx'

/**
 * A system card (e5-t52, AC-5.11, ROBOT.md §6.15): the page and the dialog a seat opens. It shows
 * what `shared/robot/system/card.ts` read off the rules, in the viewer's language (`describe.ts`).
 * It takes the system and nothing else: no table, board or hand reaches it, so opening it during
 * play can tell nobody anything about a deal.
 */

const Wrap = styled.div`
  display: grid;
  gap: 12px;
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
`

const Section = styled.details`
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};

  & > summary {
    padding: 10px 12px;
    color: ${({ theme }) => theme.colors.primaryStrong};
    font-size: 16px;
    font-weight: 700;
    cursor: pointer;
  }
  & > div {
    display: grid;
    gap: 12px;
    padding: 0 12px 12px;
  }
`

const GroupTitle = styled.h3`
  margin: 0 0 4px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
  font-weight: 700;
`

const Rows = styled.table`
  width: 100%;
  border-collapse: collapse;

  & th, & td {
    padding: 4px 8px 4px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
    vertical-align: top;
  }
  & thead th {
    border-top: 0;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  & td:first-child {
    width: 64px;
    white-space: nowrap;
    font-weight: 700;
  }
`

const Note = styled.div`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Links = styled.p`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;

  & a {
    color: ${({ theme }) => theme.colors.primary};
  }
`

const auctionText = (after: string, callText: (call: string) => string) =>
  [...after.split(' ').filter(Boolean).map((token) => (token.startsWith('(') ? `(${callText(token.slice(1, -1))})` : callText(token))), '?'].join(' ')

function Group({ group, rules }: { group: CardGroup; rules: RobotRules }) {
  const { t, lang } = usePreferences()
  const s = t.systemCard
  const title = group.seat ? s.seat(group.seat) : group.after ? auctionText(group.after, rules.callText) : s.opening
  return (
    <section>
      <GroupTitle>
        <SuitText text={title} />
      </GroupTitle>
      <Rows>
        <tbody>
          {group.calls.map(({ call, shows, vulnerable, readOnly }) => (
            <tr key={call}>
              <td>
                <CallLabel call={call} />
              </td>
              <td>
                <SuitText text={rules.describe(shows, lang)} />
                {vulnerable && (
                  <Note>
                    {s.vulnerable}
                    {t.colon}
                    <SuitText text={rules.describe(vulnerable, lang)} />
                  </Note>
                )}
                {readOnly && <Note>{s.readOnly}</Note>}
              </td>
            </tr>
          ))}
        </tbody>
      </Rows>
    </section>
  )
}

function BiddingSection({ section, open, rules }: { section: CardSection; open: boolean; rules: RobotRules }) {
  const { t } = usePreferences()
  const s = t.systemCard
  return (
    <Section open={open}>
      <summary>{s.sections[section.id]}</summary>
      <div>
        {section.groups.map((group, i) => (
          <Group key={`${group.after}|${group.seat ?? ''}|${i}`} group={group} rules={rules} />
        ))}
        {section.articles.length > 0 && (
          <Links>
            <span>{s.articles}</span>
            {section.articles.map((article) => (
              <a key={article.slug} href={bookUrl(article.slug)} target="_blank" rel="noopener noreferrer">
                {article.nameZh}
              </a>
            ))}
          </Links>
        )}
      </div>
    </Section>
  )
}

const ranks = (holding: string) => [...holding].map(rankLabel).join(' ')

export function SystemCardView({ system }: { system: RobotKind }) {
  const { t } = usePreferences()
  const s = t.systemCard
  const { card, failed } = useSystemCard(system)
  const rules = useRobotRules(true)
  if (failed) return <Muted>{s.unavailable}</Muted>
  if (!card || !rules) return <Muted>{s.loading}</Muted>
  return (
    <Wrap>
      <Muted>
        {s.intro} {system === 'tku' ? s.sourceTku : s.sourceGib}
      </Muted>
      <Muted>{s.legend}</Muted>
      {card.sections.map((section, i) => (
        <BiddingSection key={section.id} section={section} open={i === 0} rules={rules} />
      ))}
      <Section>
        <summary>{s.sections.leads}</summary>
        <div>
          <Muted>{s.leadsIntro}</Muted>
          <Rows>
            <thead>
              <tr>
                <th scope="col">{s.leadHolding}</th>
                <th scope="col">{s.leadSuit}</th>
                <th scope="col">{s.leadNotrump}</th>
              </tr>
            </thead>
            <tbody>
              {card.leads.map((lead) => (
                <tr key={lead.holding}>
                  <td>{ranks(lead.holding)}</td>
                  <td>{rankLabel(lead.suit)}</td>
                  <td>{rankLabel(lead.notrump)}</td>
                </tr>
              ))}
            </tbody>
          </Rows>
        </div>
      </Section>
      <Section>
        <summary>{s.sections.signals}</summary>
        <div>
          <Muted>{s.signalsIntro}</Muted>
          <Rows>
            <thead>
              <tr>
                <th scope="col">{s.signalHolding}</th>
                <th scope="col">{s.signalPlays}</th>
                <th scope="col">{s.signalWhen}</th>
              </tr>
            </thead>
            <tbody>
              {card.signals.map((signal) => (
                <tr key={signal.id}>
                  <td>
                    <SuitText text={`${SUIT_SYMBOL[signal.suit]} ${ranks(signal.holding)}`} />
                  </td>
                  <td>{rankLabel(signal.plays)}</td>
                  <td>{s.signals[signal.id]}</td>
                </tr>
              ))}
            </tbody>
          </Rows>
        </div>
      </Section>
    </Wrap>
  )
}

const Panel = styled(Card)`
  width: 100%;
  max-width: 720px;
  ${panelScroll}
  color: ${({ theme }) => theme.colors.text};
`

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;

  & > h2 {
    margin: 0;
    color: ${({ theme }) => theme.colors.primaryStrong};
    font-size: 20px;
  }
`

const Close = styled.button`
  display: inline-flex;
  flex: none;
  padding: 4px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: ${({ theme }) => theme.colors.textMuted};
  cursor: pointer;
`

const PageLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  color: ${({ theme }) => theme.colors.primary};
  font-size: 14px;
  font-weight: 600;
`

/** The card over the table: the table stays as it is behind it (leaving the page would leave the table) */
export function SystemCardDialog({ system, onClose }: { system: RobotKind; onClose: () => void }) {
  const { t } = usePreferences()
  const titleId = useId()
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => close.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <Backdrop onClick={(e) => e.target === e.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <Head>
          <h2 id={titleId}>{t.systemCard.cardOf(t.robotSystems[system])}</h2>
          <Close ref={close} type="button" aria-label={t.close} onClick={onClose}>
            <X size={20} aria-hidden />
          </Close>
        </Head>
        <SystemCardView system={system} />
        <PageLink href={systemCardUrl(system)} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={14} aria-hidden />
          {t.systemCard.openPage}
        </PageLink>
      </Panel>
    </Backdrop>
  )
}
