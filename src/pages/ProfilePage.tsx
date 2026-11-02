import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { Board, ForumFeed } from '../../shared/forum.ts'
import type { MemberProfile } from '../../shared/profile.ts'
import { ProfileActions, ProfileDetails } from '../components/ProfileCard.tsx'
import { Button, Card, ErrorText, Muted, PageMain } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { forumApi } from '../lib/forum.ts'
import { useAuth, useFeature } from '../state/AuthContext.tsx'
import { ForumPager, PostRows } from './ForumPages.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * A member's profile page (`/members/:userId`, AC-1.5): the profile card's content on its own page,
 * and with the forum on, their forum posts (e13-t08, AC-13.5). What the member keeps off their page
 * (隱私設定, "My account") the server leaves out; the page says so
 */

const Narrow = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
  max-width: 640px;
`

const Skeleton = styled.div`
  height: 240px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surfaceAlt};
`

const SectionTitle = styled.h3`
  margin: ${({ theme }) => theme.space(4)} 0 ${({ theme }) => theme.space(2)};
  color: ${({ theme }) => theme.colors.text};
  font-size: ${({ theme }) => theme.type.h3.size};
  line-height: ${({ theme }) => theme.type.h3.line};
`

/** The member's forum posts, newest first, a page at a time (`GET /api/forum/feed?author=`) */
function MemberPosts({ userId, hidden }: { userId: string; hidden: boolean }) {
  const { t, message } = usePreferences()
  const [page, setPage] = useState(1)
  const [loaded, setLoaded] = useState<{ key: string; feed?: ForumFeed; boards?: Board[]; error?: string } | null>(null)
  const key = `${userId}:${page}`

  useEffect(() => {
    if (hidden) return
    let live = true
    Promise.all([forumApi.feed(page, userId), forumApi.boards()])
      .then(([feed, boards]) => live && setLoaded({ key, feed, boards }))
      .catch((e) => live && setLoaded({ key, error: e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError }))
    return () => {
      live = false
    }
  }, [userId, page, key, hidden, message, t])

  const current = loaded?.key === key ? loaded : null
  return (
    <section aria-label={t.forum.profilePosts}>
      <SectionTitle>{t.forum.profilePosts}</SectionTitle>
      {hidden ? (
        <Muted>{t.forum.profilePostsHidden}</Muted>
      ) : !current ? (
        <Muted>{t.loading}</Muted>
      ) : current.error || !current.feed ? (
        <ErrorText role="alert">{current.error}</ErrorText>
      ) : current.feed.posts.length === 0 ? (
        <Muted>{t.forum.noPosts}</Muted>
      ) : (
        <>
          <PostRows posts={current.feed.posts} boards={current.boards} />
          <ForumPager page={current.feed.page} pages={current.feed.pages} onPage={setPage} />
        </>
      )}
    </section>
  )
}

const Edit = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-top: ${({ theme }) => theme.space(4)};
`

export function ProfilePage() {
  const { userId = '' } = useParams()
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const { lobby, send } = useClub()
  const forumOn = useFeature('forum')
  const [loaded, setLoaded] = useState<{
    id: string
    member?: MemberProfile
    hidden?: { boards: boolean; posts: boolean }
    error?: string
  } | null>(null)

  useEffect(() => {
    let live = true
    api
      .member(userId)
      .then((r) => live && setLoaded({ id: userId, member: r.member, hidden: r.hidden }))
      .catch(
        (e) =>
          live && setLoaded({ id: userId, error: e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError }),
      )
    return () => {
      live = false
    }
  }, [userId, message, t])

  const current = loaded?.id === userId ? loaded : null
  const member = current?.member
  const isMe = userId === user?.id
  const friend = !!lobby?.friends.includes(userId)
  const blocked = !!lobby?.blocked.includes(userId)

  return (
    <PageMain>
      <Narrow>
        {!current ? (
          <Skeleton aria-busy="true" aria-label={t.loading} />
        ) : !member ? (
          <ErrorText role="alert">{current.error}</ErrorText>
        ) : (
          <Card aria-label={t.profileOf(member.username)}>
            <ProfileDetails
              member={member}
              boardsHidden={!!current.hidden?.boards}
              after={forumOn && <MemberPosts key={userId} userId={userId} hidden={!!current.hidden?.posts} />}
              actions={
                isMe ? (
                  <Edit>
                    <Button as={Link} to="/account" $size="sm">
                      {t.editProfile}
                    </Button>
                  </Edit>
                ) : (
                  <ProfileActions
                    name={member.username}
                    friend={friend}
                    blocked={blocked}
                    onFriend={(on) => send({ type: 'setFriend', userId, friend: on })}
                    onBlock={(on) => send({ type: 'setBlocked', userId, blocked: on })}
                  />
                )
              }
            />
          </Card>
        )}
      </Narrow>
    </PageMain>
  )
}
