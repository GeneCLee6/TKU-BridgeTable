import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { noticeDismissKey, type ClubBanner, type NoticesView, type PlatformNotice } from '../../shared/notices.ts'
import { api } from '../lib/api.ts'
import { clubStorageKey } from '../lib/club.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The platform's notices and the club's banner on top of a member's pages (e12-t15, ARCHITECTURE.md
 * §1「公告」). Read once when the app opens and again when the tab comes back after a while, not on
 * every page; `GET /api/notices` is answered by the Worker from its cached read. A member dismisses
 * one on this browser only: nothing about it is stored on the server. Not at a table: a banner must
 * not push the cards down mid-game. Longer news is the forum's 社團公告 board, in `LobbyNews`.
 */

/** A tab coming back reads again after this long */
const REFRESH_MS = 10 * 60_000
const DISMISSED_KEY = 'tbt_notices_dismissed'
/** Dismissed notices a browser remembers: far more than can be out at once */
const DISMISSED_MAX = 30

const Stack = styled.section`
  display: grid;
`

const Item = styled.div<{ $platform: boolean }>`
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: 6px 16px;
  border-bottom: 1px solid ${({ theme, $platform }) => ($platform ? theme.colors.primary : theme.colors.accent)};
  background: ${({ theme, $platform }) => ($platform ? theme.colors.primarySoft : theme.colors.accentSoft)};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;

  & > p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  & strong {
    margin-inline-end: 8px;
  }
`

const Dismiss = styled.button`
  display: inline-flex;
  flex: none;
  padding: 2px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: inherit;
  cursor: pointer;
`

function readDismissed(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(clubStorageKey(DISMISSED_KEY)) ?? '[]')
    return Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

function writeDismissed(keys: string[]) {
  try {
    localStorage.setItem(clubStorageKey(DISMISSED_KEY), JSON.stringify(keys.slice(-DISMISSED_MAX)))
  } catch {
    // Private browsing: it is dismissed until the page reloads
  }
}

export function NoticeBanners() {
  const { t } = usePreferences()
  const n = t.notices
  const { pathname } = useLocation()
  const [view, setView] = useState<NoticesView | null>(null)
  const [dismissed, setDismissed] = useState<string[]>(readDismissed)

  useEffect(() => {
    let live = true
    let readAt = 0
    const read = () => {
      readAt = Date.now()
      api.notices().then(
        (found) => live && setView(found),
        // Announcements are never worth an error on a page: the last ones stay
        () => undefined,
      )
    }
    const back = () => {
      if (document.visibilityState === 'visible' && Date.now() - readAt >= REFRESH_MS) read()
    }
    read()
    document.addEventListener('visibilitychange', back)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', back)
    }
  }, [])

  if (!view || pathname.startsWith('/table/')) return null
  const shown: { notice: PlatformNotice | ClubBanner; label: string; platform: boolean }[] = [
    // A banner must never take the page down: an answer of any other shape shows nothing
    ...(Array.isArray(view.platform) ? view.platform : []).map((notice) => ({ notice, label: n.platformLabel, platform: true })),
    ...(view.club ? [{ notice: view.club, label: n.clubLabel, platform: false }] : []),
  ].filter(({ notice }) => !dismissed.includes(noticeDismissKey(notice)))
  if (!shown.length) return null
  const dismiss = (key: string) => {
    const next = [...dismissed, key]
    setDismissed(next)
    writeDismissed(next)
  }
  return (
    <Stack aria-label={n.region}>
      {shown.map(({ notice, label, platform }) => (
        <Item key={noticeDismissKey(notice)} $platform={platform}>
          <p>
            <strong>{label}</strong>
            {notice.text}
          </p>
          <Dismiss type="button" aria-label={n.dismiss} title={n.dismiss} onClick={() => dismiss(noticeDismissKey(notice))}>
            <X size={16} aria-hidden />
          </Dismiss>
        </Item>
      ))}
    </Stack>
  )
}
