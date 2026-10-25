import { Ban, Mail, Star } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { ClientMessage, LobbyView, MemberStatus } from '../../shared/protocol.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'

/**
 * The People tab (社員): every member, online first, with the viewer's friends on top of each group
 * (the server sorts them). A star follows or unfollows someone, the ban button blocks them; both
 * are only asked of the server, which answers with a new lobby. "Friends only" hides everyone else.
 * Where the page has a Messages tab, an envelope opens the conversation with that member (AC-1.7).
 */

const Bar = styled.div`
  display: flex;
  padding: 10px 12px 2px;
`

const FilterButton = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme, $active }) => ($active ? theme.colors.primary : theme.colors.surface)};
  color: ${({ theme, $active }) => ($active ? theme.colors.onPrimary : theme.colors.text)};
  font-size: 14px;
  font-weight: 700;
`

const Group = styled.h3`
  margin: 0;
  padding: 10px 14px 4px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  font-weight: 700;
`

const Person = styled.li<{ $online: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px 5px 14px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.surfaceAlt};
  opacity: ${({ $online }) => ($online ? 1 : 0.6)};
`

const Dot = styled.span<{ $online: boolean }>`
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${({ theme, $online }) => ($online ? theme.colors.success : theme.colors.border)};
`

const PersonName = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
`

const Where = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  white-space: nowrap;
`

const Tag = styled.span`
  padding: 1px 6px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.dangerSoft};
  color: ${({ theme }) => theme.colors.danger};
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
`

const RowButton = styled.button<{ $on: boolean; $tone: 'friend' | 'block' }>`
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: ${({ theme, $on, $tone }) =>
    !$on ? theme.colors.textMuted : $tone === 'friend' ? theme.colors.lantern : theme.colors.danger};
  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
`

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
`

const Empty = styled.p`
  margin: 0;
  padding: 14px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

export function PeopleList({
  lobby,
  userId,
  send,
  onMessage,
}: {
  lobby: LobbyView | null
  /** The signed-in member */
  userId: string | undefined
  send: (message: ClientMessage) => void
  /** Opens the conversation with a member; no envelope buttons without it */
  onMessage?: (userId: string) => void
}) {
  const { t } = usePreferences()
  const [onlyFriends, setOnlyFriends] = useState(false)
  const friends = new Set(lobby?.friends ?? [])
  const blocked = new Set(lobby?.blocked ?? [])
  const members = (lobby?.members ?? []).filter((m) => !onlyFriends || friends.has(m.id))
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)

  const where = (m: MemberStatus) => {
    if (m.tableNumber === null) return m.online ? t.inLobby : ''
    const table = lobby?.tables.find((x) => x.number === m.tableNumber)
    const text = t.atTable(m.tableNumber, m.seat ? seatLetter[m.seat] : null)
    return table && m.id !== userId ? <Link to={`/table/${table.id}`}>{text}</Link> : text
  }

  const row = (m: MemberStatus) => {
    const me = m.id === userId
    const friend = friends.has(m.id)
    const isBlocked = blocked.has(m.id)
    const friendLabel = friend ? t.removeFriend(m.username) : t.addFriend(m.username)
    const blockLabel = isBlocked ? t.unblockMember(m.username) : t.blockMember(m.username)
    return (
      <Person key={m.id} $online={m.online}>
        <Dot $online={m.online} aria-label={m.online ? t.online : t.offline} />
        <PersonName>
          {m.username}
          {me && t.youTag}
        </PersonName>
        {isBlocked && <Tag>{t.blockedTag}</Tag>}
        <Where>{where(m)}</Where>
        {!me && (
          <>
            {onMessage && (
              <RowButton
                type="button"
                $on={false}
                $tone="friend"
                aria-label={t.messageMember(m.username)}
                title={t.messageMember(m.username)}
                onClick={() => onMessage(m.id)}
              >
                <Mail size={17} aria-hidden />
              </RowButton>
            )}
            <RowButton
              type="button"
              $on={friend}
              $tone="friend"
              aria-pressed={friend}
              aria-label={friendLabel}
              title={friendLabel}
              disabled={isBlocked}
              onClick={() => send({ type: 'setFriend', userId: m.id, friend: !friend })}
            >
              <Star size={17} fill={friend ? 'currentColor' : 'none'} aria-hidden />
            </RowButton>
            <RowButton
              type="button"
              $on={isBlocked}
              $tone="block"
              aria-pressed={isBlocked}
              aria-label={blockLabel}
              title={blockLabel}
              onClick={() => send({ type: 'setBlocked', userId: m.id, blocked: !isBlocked })}
            >
              <Ban size={17} aria-hidden />
            </RowButton>
          </>
        )}
      </Person>
    )
  }

  return (
    <div>
      <Bar>
        <FilterButton
          type="button"
          $active={onlyFriends}
          aria-pressed={onlyFriends}
          onClick={() => setOnlyFriends((on) => !on)}
        >
          <Star size={15} fill={onlyFriends ? 'currentColor' : 'none'} aria-hidden />
          {t.onlyFriends}
        </FilterButton>
      </Bar>
      {onlyFriends && members.length === 0 ? (
        <Empty>{t.noFriends}</Empty>
      ) : (
        <>
          <Group>{t.onlineCount(online.length)}</Group>
          <List>{online.map(row)}</List>
          <Group>{t.offlineCount(offline.length)}</Group>
          <List>{offline.map(row)}</List>
        </>
      )}
    </div>
  )
}
