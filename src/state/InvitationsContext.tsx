import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { InviteBanner, InviteDialog } from '../components/InviteDialog.tsx'
import { useToast } from '../components/Toast.tsx'
import { api, ApiError } from '../lib/api.ts'
import {
  HANDLED_KEY,
  mark,
  marked,
  newsKey,
  pendingInvites,
  RANG_KEY,
  stillOpen,
  type InviteDetail,
  type InviteTarget,
  type PendingInvite,
} from '../lib/invites.ts'
import { useSoundPrefs } from '../lib/sound/hooks.ts'
import { cueNews } from '../lib/sound/player.ts'
import { useAuth } from './AuthContext.tsx'
import { useClub } from './ClubContext.tsx'
import { usePreferences } from './PreferencesContext.tsx'

/**
 * Invitations that pop up (`e1-t35`): a challenge or a seat in a team match. From the bell's
 * notifications, so one that came while the member was away pops up when they sign in or come
 * back; each is checked against the challenge or match (still open, still theirs to answer) and
 * they pop up one at a time, oldest first, with a sound in one tab only. Answering, putting it
 * off or closing one that no longer stands is remembered in this browser (`src/lib/invites.ts`),
 * and other tabs close it too. While the member is playing at a table, the invitation waits as a
 * banner in the header (`InviteBanner`, through this context) and opens on a click.
 */

type Fetched = { state: 'loading' } | { state: 'ok'; detail: InviteDetail } | { state: 'gone' }

interface Invitations {
  /** The banner the header shows while the member plays at a table, or null */
  banner: ReactNode
}

const InvitationsContext = createContext<Invitations>({ banner: null })

const linkOf = (t: InviteTarget) => (t.kind === 'challenge' ? `/challenges/${encodeURIComponent(t.id)}` : `/matches/${encodeURIComponent(t.id)}`)

async function fetchDetail(t: InviteTarget): Promise<InviteDetail> {
  if (t.kind === 'challenge') return { kind: 'challenge', challenge: (await api.challenge(t.id)).challenge }
  return { kind: 'match', match: (await api.match(t.id)).match }
}

/** Hidden tabs wait this long before ringing, so the tab in front rings when there is one */
const HIDDEN_RING_DELAY = 400
/** Longer than this a timer cannot wait (setTimeout's limit) */
const MAX_TIMER = 2 ** 31 - 1

export function InvitationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { notifications, matchLive, table, send } = useClub()
  const { t, message } = usePreferences()
  const toast = useToast()
  const prefs = useSoundPrefs()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const userId = user?.id

  const [handled, setHandled] = useState(() => marked(HANDLED_KEY))
  const [fetched, setFetched] = useState<Record<string, Fetched>>({})
  const [currentKey, setCurrentKey] = useState<string | null>(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** What was asked for, by account and challenge or match: another account signing in starts afresh */
  const requested = useRef(new Set<string>())
  const slot = useCallback((key: string) => `${userId ?? ''}|${key}`, [userId])
  const [owner, setOwner] = useState(userId)
  if (owner !== userId) {
    setOwner(userId)
    setCurrentKey(null)
  }

  // Another tab answered or put off an invitation
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === HANDLED_KEY || event.key === null) setHandled(marked(HANDLED_KEY))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const items = useMemo(() => notifications?.items ?? [], [notifications])
  const pending = useMemo(() => pendingInvites(items, handled), [items, handled])

  const load = useCallback(
    (key: string, target: InviteTarget) => {
      const at = slot(key)
      requested.current.add(at)
      fetchDetail(target).then(
        (detail) => {
          setNow(Date.now())
          setFetched((all) => ({ ...all, [at]: { state: 'ok', detail } }))
        },
        // Not found or not theirs to see: it does not pop up. Without a connection it is tried again later
        (error: unknown) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500)
            setFetched((all) => ({ ...all, [at]: { state: 'gone' } }))
          else requested.current.delete(at)
        },
      )
    },
    [slot],
  )

  // Each pending invitation's challenge or match, once
  useEffect(() => {
    if (!userId) return
    for (const p of pending) if (!requested.current.has(slot(p.key))) load(p.key, p.target)
  }, [pending, userId, load, slot])

  // News about one of them (called off, taken off the seat, invited again) fetches it again
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!notifications) return
    const known = seen.current
    seen.current = new Set(items.map((n) => n.id))
    if (!known) return
    for (const n of items) {
      if (known.has(n.id)) continue
      const key = newsKey(n)
      const p = key && requested.current.has(slot(key)) ? pending.find((x) => x.key === key) : undefined
      if (p) load(p.key, p.target)
    }
  }, [notifications, items, pending, load, slot])

  // The match itself, pushed while the member is in it; null once they may no longer see it
  useEffect(() => {
    if (!matchLive) return
    const at = slot(`match:${matchLive.matchId}`)
    if (!requested.current.has(at)) return
    setFetched((all) => ({ ...all, [at]: matchLive.match ? { state: 'ok', detail: { kind: 'match', match: matchLive.match } } : { state: 'gone' } }))
  }, [matchLive, slot])

  const isOpen = useCallback(
    (p: PendingInvite) => {
      const f = fetched[slot(p.key)]
      return !!userId && f?.state === 'ok' && stillOpen(f.detail, userId, now)
    },
    [fetched, userId, now, slot],
  )
  const waiting = useMemo(() => pending.filter(isOpen), [pending, isOpen])
  const current = currentKey ? pending.find((p) => p.key === currentKey) : undefined

  // The next one pops up when none is showing; one answered in another tab closes here too. It
  // stays once shown, even when it stops standing, so the member sees that it did
  if (currentKey && !current) setCurrentKey(null)
  else if (!currentKey && waiting.length) {
    setCurrentKey(waiting[0].key)
    setOpened(false)
  }

  // It rings once in this browser: the tab in front first
  const ringId = current?.latest.id
  useEffect(() => {
    if (!ringId) return
    const ring = () => {
      if (mark(RANG_KEY, [ringId])) cueNews('invite', prefs)
    }
    if (!document.hidden) {
      ring()
      return
    }
    const timer = setTimeout(ring, HIDDEN_RING_DELAY)
    return () => clearTimeout(timer)
  }, [ringId, prefs])

  // A challenge's deadline passing while it shows
  const shown = currentKey ? fetched[slot(currentKey)] : undefined
  const deadline = shown?.state === 'ok' && shown.detail.kind === 'challenge' ? shown.detail.challenge.deadline : null
  useEffect(() => {
    if (deadline === null) return
    const wait = deadline - Date.now()
    if (wait <= 0 || wait > MAX_TIMER) return
    const timer = setTimeout(() => setNow(Date.now()), wait + 50)
    return () => clearTimeout(timer)
  }, [deadline])

  const atTable = pathname.startsWith('/table/') && !!table?.mySeat

  const done = useCallback((p: PendingInvite) => {
    mark(HANDLED_KEY, p.ids)
    setHandled(marked(HANDLED_KEY))
    setCurrentKey(null)
    setOpened(false)
  }, [])

  const answer = useCallback(
    async (p: PendingInvite, accept: boolean) => {
      setBusy(true)
      try {
        if (p.target.kind === 'challenge') await api.answerChallenge(p.target.id, accept)
        else await api.matchSeat(p.target.id, { action: 'answer', accept })
        const unread = items.filter((n) => p.ids.includes(n.id) && !n.read).map((n) => n.id)
        if (unread.length) send({ type: 'readNotifications', ids: unread })
        done(p)
        if (!accept) toast.success(t.invites.declined)
        // Leaving the table page would leave the table
        else if (atTable) toast.success(t.invites.acceptedAtTable)
        else {
          toast.success(t.invites.accepted)
          navigate(linkOf(p.target))
        }
      } catch (error) {
        const e = error instanceof ApiError ? error : null
        toast.error(message(e?.code ?? 'serverError', e?.params ?? {}, e?.message ?? String(error)))
        // It may no longer stand: see how it is now
        load(p.key, p.target)
      } finally {
        setBusy(false)
      }
    },
    [items, send, done, toast, t, atTable, navigate, message, load],
  )

  const stale = !!current && (shown?.state === 'gone' || (shown?.state === 'ok' && !!userId && !stillOpen(shown.detail, userId, now)))
  const more = current ? waiting.filter((p) => p.key !== current.key).length : 0

  const dialog =
    current && userId && (!atTable || opened) ? (
      <InviteDialog
        invite={current.latest}
        detail={shown?.state === 'ok' ? shown.detail : null}
        userId={userId}
        now={now}
        more={more}
        stale={stale}
        busy={busy}
        onAccept={() => void answer(current, true)}
        onDecline={() => void answer(current, false)}
        onLater={() => done(current)}
      />
    ) : null

  const banner = current && atTable && !opened ? <InviteBanner invite={current.latest} count={more + 1} onOpen={() => setOpened(true)} /> : null
  return (
    <InvitationsContext.Provider value={{ banner }}>
      {children}
      {dialog}
    </InvitationsContext.Provider>
  )
}

/** The banner for the header, while the member plays at a table and an invitation waits */
// oxlint-disable-next-line react/only-export-components
export function useInviteBanner(): ReactNode {
  return useContext(InvitationsContext).banner
}
