import { Ban, Mail, Star, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { MemberProfile } from '../../shared/profile.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Avatar } from './Avatar.tsx'
import { ContractLabel } from './Suit.tsx'
import { Button, Card, ErrorText, Muted } from './ui.tsx'
import { boardPlace } from '../strings.ts'

/**
 * A member's profile (AC-1.5): avatar, display name, level, system, introduction and their latest
 * boards the viewer may see. `ProfileDetails` is the content, shared by the card that opens from a
 * name in the People tab (`ProfileCard`, e1-t17) and the profile page (`/members/:id`).
 */

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(3)};
  min-width: 0;
`

const Names = styled.div`
  display: grid;
  min-width: 0;

  & > h2 {
    margin: 0;
    overflow: hidden;
    color: ${({ theme }) => theme.colors.text};
    font-size: ${({ theme }) => theme.type.h2.size};
    line-height: ${({ theme }) => theme.type.h2.line};
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)};
  margin-top: ${({ theme }) => theme.space(3)};
`

const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.small.size};
  font-weight: 600;

  & > span { color: ${({ theme }) => theme.colors.textMuted}; font-weight: 400; }
`

const Bio = styled.p`
  margin: ${({ theme }) => theme.space(3)} 0 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
`

const SectionTitle = styled.h3`
  margin: ${({ theme }) => theme.space(4)} 0 ${({ theme }) => theme.space(2)};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.h3.size};
  line-height: ${({ theme }) => theme.type.h3.line};
`

const Boards = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;

  & > li + li { border-top: 1px solid ${({ theme }) => theme.colors.border}; }
  & a {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: ${({ theme }) => theme.space(3)};
    padding: ${({ theme }) => theme.space(2)} 0;
    color: inherit;
    text-decoration: none;
    font-size: 14px;
  }
  & a:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
`

const Score = styled.span<{ $value: number }>`
  min-width: 52px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: ${({ $value, theme }) => ($value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger)};
`

export function ProfileDetails({
  member,
  newTab = false,
  actions,
}: {
  member: MemberProfile
  /** Open board links in a new tab (from a table, so the player keeps their seat) */
  newTab?: boolean
  /** Buttons under the introduction: friend, block, message */
  actions?: ReactNode
}) {
  const { t, lang } = usePreferences()
  const { profile } = member
  const title = profile.displayName ?? member.username
  const empty = !profile.level && !profile.system && !profile.bio
  const target = newTab ? { target: '_blank', rel: 'noopener' } : {}
  return (
    <>
      <Head>
        <Avatar id={member.id} name={title} size={56} />
        <Names>
          <h2>{title}</h2>
          {profile.displayName && <Muted>{t.accountName(member.username)}</Muted>}
        </Names>
      </Head>
      {(profile.level || profile.system) && (
        <Chips>
          {profile.level && (
            <Chip>
              <span>{t.profileLevel}</span>
              {t.levelNames[profile.level]}
            </Chip>
          )}
          {profile.system && (
            <Chip>
              <span>{t.profileSystem}</span>
              {profile.system}
            </Chip>
          )}
        </Chips>
      )}
      {profile.bio && <Bio>{profile.bio}</Bio>}
      {empty && <Muted style={{ marginTop: 12 }}>{t.profileEmpty}</Muted>}
      {actions}
      <SectionTitle>{t.recentBoards}</SectionTitle>
      {member.recent.length === 0 ? (
        <Muted>{t.noRecentBoards}</Muted>
      ) : (
        <Boards>
          {member.recent.map((b) => (
            <li key={b.id}>
              <Link to={`/history/${b.id}`} {...target}>
                <span>
                  {formatDateTime(b.finishedAt, lang)} · {boardPlace(t, b)}{' '}
                  {t.boardNo(b.boardNo)}
                </span>
                <span>
                  <ContractLabel contract={b.contract} /> {b.contract ? resultLabel(b.contract, b.result.declarerTricks) : ''}
                </span>
                <Score $value={b.result.scoreNS}>{signed(b.result.scoreNS)}</Score>
              </Link>
            </li>
          ))}
        </Boards>
      )}
    </>
  )
}

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)};
  margin-top: ${({ theme }) => theme.space(4)};
`

/** Friend, message and block, for someone other than the viewer; each is only asked of the server */
export function ProfileActions({
  name,
  friend,
  blocked,
  onFriend,
  onBlock,
  onMessage,
}: {
  name: string
  friend: boolean
  blocked: boolean
  onFriend: (friend: boolean) => void
  onBlock: (blocked: boolean) => void
  /** Opens the conversation; no button without it */
  onMessage?: () => void
}) {
  const { t } = usePreferences()
  return (
    <ActionRow>
      <Button
        type="button"
        $size="sm"
        aria-pressed={friend}
        aria-label={friend ? t.removeFriend(name) : t.addFriend(name)}
        disabled={blocked}
        onClick={() => onFriend(!friend)}
      >
        <Star size={15} fill={friend ? 'currentColor' : 'none'} aria-hidden />
        {friend ? t.unfriendShort : t.friendShort}
      </Button>
      {onMessage && (
        <Button type="button" $size="sm" aria-label={t.messageMember(name)} disabled={blocked} onClick={onMessage}>
          <Mail size={15} aria-hidden />
          {t.messageShort}
        </Button>
      )}
      <Button
        type="button"
        $size="sm"
        $variant="ghost"
        aria-pressed={blocked}
        aria-label={blocked ? t.unblockMember(name) : t.blockMember(name)}
        onClick={() => onBlock(!blocked)}
      >
        <Ban size={15} aria-hidden />
        {blocked ? t.unblockShort : t.blockShort}
      </Button>
    </ActionRow>
  )
}

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
  position: relative;
  width: 100%;
  max-width: 440px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadowRaised};
`

const CloseButton = styled(Button)`
  position: absolute;
  top: 12px;
  right: 12px;
  width: 32px;
  padding: 0;
`

const Footer = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: ${({ theme }) => theme.space(4)};
`

const Skeleton = styled.div`
  height: 120px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

/** The profile card, opened from a member's name; Escape, the × or a click outside closes it */
export function ProfileCard({
  userId,
  name,
  isMe,
  friend,
  blocked,
  onFriend,
  onBlock,
  onMessage,
  onClose,
  newTab = false,
}: {
  userId: string
  name: string
  isMe: boolean
  friend: boolean
  blocked: boolean
  onFriend: (friend: boolean) => void
  onBlock: (blocked: boolean) => void
  onMessage?: () => void
  onClose: () => void
  newTab?: boolean
}) {
  const { t, message } = usePreferences()
  const [loaded, setLoaded] = useState<{ id: string; member?: MemberProfile; error?: string } | null>(null)
  const titleId = useId()
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    api
      .member(userId)
      .then((r) => live && setLoaded({ id: userId, member: r.member }))
      .catch(
        (e) =>
          live && setLoaded({ id: userId, error: e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError }),
      )
    return () => {
      live = false
    }
  }, [userId, message, t])

  useEffect(() => {
    close.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = loaded?.id === userId ? loaded : null
  const linkProps = newTab ? { target: '_blank', rel: 'noopener' } : {}
  return (
    <Backdrop onClick={(e) => e.target === e.currentTarget && onClose()}>
      <Panel as="div" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span id={titleId} className="visually-hidden">
          {t.profileOf(name)}
        </span>
        <CloseButton ref={close} type="button" $size="sm" $variant="ghost" aria-label={t.close} title={t.close} onClick={onClose}>
          <X size={18} aria-hidden />
        </CloseButton>
        {!current ? (
          <Skeleton aria-busy="true" aria-label={t.loading} />
        ) : current.error || !current.member ? (
          <ErrorText role="alert">{current.error}</ErrorText>
        ) : (
          <ProfileDetails
            member={current.member}
            newTab={newTab}
            actions={
              isMe ? undefined : (
                <ProfileActions
                  name={name}
                  friend={friend}
                  blocked={blocked}
                  onFriend={onFriend}
                  onBlock={onBlock}
                  onMessage={onMessage}
                />
              )
            }
          />
        )}
        <Footer>
          {isMe ? (
            <Button as={Link} to="/account" $size="sm" {...linkProps}>
              {t.editProfile}
            </Button>
          ) : (
            <Button as={Link} to={`/members/${userId}`} $size="sm" $variant="ghost" {...linkProps}>
              {t.fullProfile}
            </Button>
          )}
        </Footer>
      </Panel>
    </Backdrop>
  )
}
