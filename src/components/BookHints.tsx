import { BookOpen, ExternalLink } from 'lucide-react'
import { useMemo } from 'react'
import styled from 'styled-components'
import type { BookTopic } from '../../shared/book-topics.ts'
import { BOOK_SITE, bookUrl } from '../../shared/book-site.ts'
import { sideOf, type Seat } from '../../shared/cards.ts'
import type { BoardView, RobotKind } from '../../shared/protocol.ts'
import { useRobotRules } from '../lib/useRobotRules.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Muted } from './ui.tsx'

/**
 * The side panel's 特約 tab (`e10-t06`, AC-10.4): the TKU BridgeBook pages that go with the auction
 * on the table (`shared/book-topics.ts`), each opening the book in a new tab. Read from the club's
 * rules, which load only when the tab is open
 */

const Wrap = styled.div`
  display: grid;
  gap: 12px;
  padding: 12px 14px;

  & h3 {
    margin: 0 0 6px;
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 700;
  }
  & ul {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
`

const TopicLink = styled.a`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  color: ${({ theme }) => theme.colors.text};
  font-weight: 600;
  text-decoration: none;

  &:hover { border-color: ${({ theme }) => theme.colors.primary}; }
  & > svg { flex: none; color: ${({ theme }) => theme.colors.textMuted}; }
`

const BookLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: ${({ theme }) => theme.colors.primary};
  font-size: 14px;
  font-weight: 600;
`

export function BookHints({ board, seat, robotKind }: { board: BoardView | null; seat: Seat | null; robotKind: RobotKind }) {
  const { t, lang } = usePreferences()
  const rules = useRobotRules(robotKind === 'tku')
  const topics = useMemo(() => {
    if (!rules || !board || robotKind !== 'tku') return null
    const side = sideOf(seat ?? 'S')
    return rules.bookTopics(rules.ROBOT_SYSTEMS.tku, board.auction, board.dealer, board.vul, side, board.phase !== 'auction')
  }, [rules, board, seat, robotKind])

  const label = (topic: BookTopic) => {
    if (!rules) return topic.slug
    if (topic.kind === 'opening') return t.conventionsOpening(rules.callText(topic.call))
    if (topic.kind === 'competition') return t.conventionsCompetition
    return topic.conventions.map((name) => rules.conventionName(name, lang)).join(' · ')
  }

  const list = (title: string, items: BookTopic[]) =>
    items.length > 0 && (
      <section>
        <h3>{title}</h3>
        <ul>
          {items.map((topic) => (
            <li key={topic.slug}>
              <TopicLink href={bookUrl(topic.slug)} target="_blank" rel="noopener noreferrer">
                <span>{label(topic)}</span>
                <ExternalLink size={14} aria-hidden />
              </TopicLink>
            </li>
          ))}
        </ul>
      </section>
    )

  return (
    <Wrap>
      {robotKind === 'gib' ? (
        <Muted>{t.conventionsGib}</Muted>
      ) : !topics || topics.soFar.length + topics.next.length === 0 ? (
        <Muted>{t.conventionsNone}</Muted>
      ) : (
        <>
          <Muted>{t.conventionsIntro}</Muted>
          {list(t.conventionsSoFar, topics.soFar)}
          {list(t.conventionsNext, topics.next)}
        </>
      )}
      <BookLink href={BOOK_SITE} target="_blank" rel="noopener noreferrer">
        <BookOpen size={16} aria-hidden />
        {t.conventionsOpenBook}
      </BookLink>
    </Wrap>
  )
}
