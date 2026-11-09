import { useEffect, useState } from 'react'
import { CLUB_LOGO_API } from '../../shared/club-logo.ts'
import { CLUB_PATH_PREFIX, DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { currentClub } from './club.ts'

/** The name of the club these pages are for, and its logo's address when it has one (AC-12.2) */
export interface ClubBrand {
  name: string
  logo: string | null
}

interface Manifest {
  short_name?: unknown
  icons?: unknown
}

/** The club's logo among a manifest's icons: the one the Worker put there from `/api/logo` (worker/manifest.ts) */
export function manifestLogo(icons: unknown): string | null {
  if (!Array.isArray(icons)) return null
  const logo = icons.find(
    (icon: unknown) => typeof (icon as { src?: unknown })?.src === 'string' && (icon as { src: string }).src.startsWith(`${CLUB_LOGO_API}?`),
  ) as { src: string } | undefined
  return logo?.src ?? null
}

/**
 * The club these pages are for, to show beside the platform's (DESIGN.md §6). 淡江's name is in the
 * strings and it keeps its lantern (no logo). Another club's name is the `short_name` of its
 * home-screen manifest, the one public and cached place the Worker already says it
 * (`worker/manifest.ts`), signed in or not, and its logo is that manifest's icon when the club set
 * one; its id and no logo until that answers, and if it never does
 */
export function useClubBrand(): ClubBrand {
  const { t } = usePreferences()
  const club = currentClub()
  const [brand, setBrand] = useState<ClubBrand | null>(null)
  useEffect(() => {
    if (club === DEFAULT_CLUB_ID) return
    let live = true
    fetch(`${CLUB_PATH_PREFIX}${club}/manifest.webmanifest`)
      .then((response) => (response.ok ? (response.json() as Promise<Manifest>) : null))
      .then((manifest) => {
        if (live && typeof manifest?.short_name === 'string') setBrand({ name: manifest.short_name, logo: manifestLogo(manifest.icons) })
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [club])
  if (club === DEFAULT_CLUB_ID) return { name: t.tkuClubName, logo: null }
  return brand ?? { name: club, logo: null }
}

/** The club's name alone (see `useClubBrand`) */
export function useClubName(): string {
  return useClubBrand().name
}
