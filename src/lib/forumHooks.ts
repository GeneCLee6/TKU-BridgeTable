import { useCallback } from 'react'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'

/** The forum pages' shared hooks (E13; `ForumPages.tsx`, `ForumModerationPages.tsx`) */

/** A member's name from the lobby's member list; a member who left shows as such */
export function useMemberName() {
  const { t } = usePreferences()
  const { lobby } = useClub()
  return useCallback(
    (id: string) => {
      const member = lobby?.members.find((m) => m.id === id)
      return member ? playerName(t, member) : t.forum.unknownMember
    },
    [lobby, t],
  )
}

/** An officer of the forum (`forumModerate`, or an admin): the server checks the same */
export function useOfficer() {
  const { user } = useAuth()
  return !!user && (user.admin || user.permissions.includes('forumModerate'))
}
