import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import type { MemberProfile } from '../../shared/profile.ts'
import { ProfileActions, ProfileDetails } from '../components/ProfileCard.tsx'
import { Button, Card, ErrorText, PageMain } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/** A member's profile page (`/members/:userId`, AC-1.5): the profile card's content on its own page */

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
  const [loaded, setLoaded] = useState<{ id: string; member?: MemberProfile; error?: string } | null>(null)

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
