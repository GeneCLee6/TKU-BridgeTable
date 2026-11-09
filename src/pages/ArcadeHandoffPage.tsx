import { useEffect } from 'react'
import { ARCADE_LOGIN_API } from '../../shared/arcade.ts'
import { PageMain } from '../components/ui.tsx'
import { leave } from '../lib/leave.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * `/arcade` once signed in (e1-t37): a visitor TKU Arcade sent here has signed in on this page, so
 * back to the endpoint, which signs the token and sends them on to the arcade. `resume=1` stops a
 * loop if the endpoint still finds no session. The endpoint checks `return_to` again, so this page
 * never leads anywhere that is not on its list
 */
export function ArcadeHandoffPage() {
  const { t } = usePreferences()
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('resume', '1')
    leave.to(`${ARCADE_LOGIN_API}?${params}`)
  }, [])
  return <PageMain>{t.loading}</PageMain>
}
