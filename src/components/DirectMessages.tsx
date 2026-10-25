import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import styled from 'styled-components'
import {
  LIMITS,
  type ClientMessage,
  type DirectMessage,
  type DirectPage,
  type DirectsView,
  type PublicUser,
} from '../../shared/protocol.ts'
import { formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The Messages tab (私訊, AC-1.7): the viewer's conversations, newest first with unread counts, and
 * one conversation at a time. A conversation loads its newest page over HTTP and pages back with
 * "load earlier"; messages that arrive over the socket (`live`) are added to it. Opening it marks
 * it read. The server checks everything (blocks, length, rate); the form only keeps to the limit.
 */

const Empty = styled.p`
  margin: 0;
  padding: 14px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`

const Row = styled.button`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px 8px;
  width: 100%;
  padding: 8px 14px;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  background: none;
  text-align: left;
  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
`

const Name = styled.span<{ $unread: boolean }>`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: ${({ $unread }) => ($unread ? 800 : 600)};
`

const When = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 12px;
  white-space: nowrap;
`

const Preview = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Badge = styled.span`
  justify-self: end;
  min-width: 20px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.danger};
  color: ${({ theme }) => theme.colors.onPrimary};
  font-size: 12px;
  font-weight: 700;
  text-align: center;
`

const Thread = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`

const ThreadBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  font-weight: 700;
`

const SmallButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 0 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surface};
  font-size: 14px;
  font-weight: 600;
`

const Log = styled.ol`
  flex: 1;
  min-height: 160px;
  margin: 0;
  padding: 8px 12px;
  overflow-y: auto;
  list-style: none;
  font-size: 14px;
  line-height: 1.5;
`

const Older = styled.li`
  display: flex;
  justify-content: center;
  padding-bottom: 6px;
`

const Bubble = styled.li<{ $mine: boolean }>`
  max-width: 85%;
  margin: 0 0 6px ${({ $mine }) => ($mine ? 'auto' : '0')};
  padding: 6px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $mine }) => ($mine ? theme.colors.primary : theme.colors.surfaceAlt)};
  color: ${({ theme, $mine }) => ($mine ? theme.colors.onPrimary : theme.colors.text)};
  overflow-wrap: anywhere;
  white-space: pre-wrap;

  & > small { display: block; opacity: 0.75; font-size: 11px; }
`

const Form = styled.form`
  display: flex;
  gap: 6px;
  padding: 8px;
  border-top: 1px solid ${({ theme }) => theme.colors.border};
`

const Input = styled.input`
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.bg};
`

const Send = styled.button`
  min-height: 36px;
  padding: 0 12px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primary};
  color: ${({ theme }) => theme.colors.onPrimary};
  font-weight: 600;
  &:disabled { opacity: 0.5; }
`

export interface DirectMessagesProps {
  /** The signed-in member */
  me: string | undefined
  directs: DirectsView | null
  live: DirectMessage[]
  /** Every member, to name someone the viewer has not written to yet */
  members: PublicUser[]
  /** Members the viewer blocked: their conversation shows why it cannot be written to */
  blocked: string[]
  /** The open conversation, or null for the list */
  talkTo: string | null
  onTalkTo: (userId: string | null) => void
  send: (message: ClientMessage) => void
  load: (userId: string, before?: number) => Promise<DirectPage>
}

export function DirectMessages(props: DirectMessagesProps) {
  const { t, lang } = usePreferences()
  const { directs, talkTo, onTalkTo, me } = props
  if (talkTo) return <Conversation {...props} talkTo={talkTo} />

  const conversations = directs?.conversations ?? []
  if (!directs) return <Empty>{t.loading}</Empty>
  if (conversations.length === 0) return <Empty>{t.noConversations}</Empty>
  return (
    <List>
      {conversations.map((c) => (
        <li key={c.user.id}>
          <Row
            type="button"
            onClick={() => onTalkTo(c.user.id)}
            aria-label={c.unread ? `${c.user.username} · ${t.tabUnread(c.unread)}` : c.user.username}
          >
            <Name $unread={c.unread > 0}>{c.user.username}</Name>
            <When>{formatDateTime(c.last.at, lang)}</When>
            <Preview>
              {c.last.from === me && t.youSaid}
              {c.last.text}
            </Preview>
            {c.unread > 0 ? <Badge>{c.unread}</Badge> : <span />}
          </Row>
        </li>
      ))}
    </List>
  )
}

function Conversation({ me, directs, live, members, blocked, talkTo, onTalkTo, send, load }: DirectMessagesProps & { talkTo: string }) {
  const { t, lang } = usePreferences()
  const [loaded, setLoaded] = useState<{ userId: string; messages: DirectMessage[]; more: boolean } | null>(null)
  const [text, setText] = useState('')
  const log = useRef<HTMLOListElement>(null)
  const conversation = directs?.conversations.find((c) => c.user.id === talkTo)
  const name = conversation?.user.username ?? members.find((m) => m.id === talkTo)?.username ?? ''
  const unread = conversation?.unread ?? 0
  const isBlocked = blocked.includes(talkTo)

  useEffect(() => {
    let cancelled = false
    load(talkTo)
      .then((page) => !cancelled && setLoaded({ userId: talkTo, ...page }))
      .catch(() => !cancelled && setLoaded({ userId: talkTo, messages: [], more: false }))
    return () => {
      cancelled = true
    }
  }, [talkTo, load])

  // Reading the conversation marks it read, also when a message arrives while it is open
  useEffect(() => {
    if (unread > 0) send({ type: 'readDirect', userId: talkTo })
  }, [talkTo, unread, send])

  const page = loaded?.userId === talkTo ? loaded : null
  const known = new Set(page?.messages.map((m) => m.id))
  const messages = [
    ...(page?.messages ?? []),
    ...live.filter(
      (m) => !known.has(m.id) && ((m.from === me && m.to === talkTo) || (m.from === talkTo && m.to === me)),
    ),
  ].sort((a, b) => a.id - b.id)

  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight })
  }, [messages.length])

  const older = () => {
    const first = page?.messages[0]
    if (!first) return
    void load(talkTo, first.id).then((older) =>
      setLoaded((current) =>
        current?.userId === talkTo ? { userId: talkTo, messages: [...older.messages, ...current.messages], more: older.more } : current,
      ),
    )
  }

  return (
    <Thread>
      <ThreadBar>
        <SmallButton type="button" onClick={() => onTalkTo(null)}>
          <ArrowLeft size={16} aria-hidden />
          {t.allConversations}
        </SmallButton>
        <span>{name}</span>
      </ThreadBar>
      <Log ref={log} aria-label={t.conversationWith(name)} aria-live="polite">
        {page?.more && (
          <Older>
            <SmallButton type="button" onClick={older}>
              {t.olderMessages}
            </SmallButton>
          </Older>
        )}
        {!page ? (
          <Older>{t.loading}</Older>
        ) : messages.length === 0 ? (
          <Older>{t.noMessagesYet}</Older>
        ) : (
          messages.map((m) => (
            <Bubble key={m.id} $mine={m.from === me}>
              {m.text}
              <small>{formatDateTime(m.at, lang)}</small>
            </Bubble>
          ))
        )}
      </Log>
      {isBlocked && <Empty role="note">{t.blockedCannotMessage}</Empty>}
      <Form
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim() || isBlocked) return
          send({ type: 'sendDirect', to: talkTo, text })
          setText('')
        }}
      >
        <Input
          value={text}
          maxLength={LIMITS.directMax}
          onChange={(e) => setText(e.target.value)}
          placeholder={t.directPlaceholder}
          aria-label={t.directPlaceholder}
          disabled={isBlocked}
        />
        <Send type="submit" disabled={isBlocked}>
          {t.send}
        </Send>
      </Form>
    </Thread>
  )
}
