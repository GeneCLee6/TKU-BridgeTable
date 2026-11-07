import { useEffect, useState } from 'react'
import { CLUB_PATH_PREFIX, DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { currentClub } from './club.ts'

/**
 * The name of the club these pages are for, to show beside the platform's (DESIGN.md §6). 淡江's is
 * in the strings. Another club's is the `short_name` of its home-screen manifest, the one public and
 * cached place the Worker already says it (`worker/manifest.ts`), signed in or not; its id until
 * that answers, and if it never does
 */
export function useClubName(): string {
  const { t } = usePreferences()
  const club = currentClub()
  const [named, setNamed] = useState<string | null>(null)
  useEffect(() => {
    if (club === DEFAULT_CLUB_ID) return
    let live = true
    fetch(`${CLUB_PATH_PREFIX}${club}/manifest.webmanifest`)
      .then((response) => (response.ok ? (response.json() as Promise<{ short_name?: unknown }>) : null))
      .then((manifest) => {
        if (live && typeof manifest?.short_name === 'string') setNamed(manifest.short_name)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [club])
  return club === DEFAULT_CLUB_ID ? t.tkuClubName : (named ?? club)
}
