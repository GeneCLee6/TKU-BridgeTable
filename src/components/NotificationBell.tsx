import { Bell } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import type { NotificationsView } from '../../shared/protocol.ts'
import { formatDateTime } from '../lib/format.ts'
import { notificationLink, notificationText } from '../lib/notifications.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'

/** The header bell (AC-1.8): unread count, the newest notifications, each leading to its page */

const Wrap = styled.div`
  position: relative;
`

const BellButton = styled.button`
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: transparent;
  color: ${({ theme }) => theme.colors.textMuted};

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }

  & > b {
    position: absolute;
    top: 2px;
    right: 0;
    display: inline-grid;
    place-items: center;
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    border-radius: 999px;
    background: ${({ theme }) => theme.colors.danger};
    color: ${({ theme }) => theme.colors.onPrimary};
    font-size: 11px;
    line-height: 1;
  }
`

const Panel = styled.div`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  width: 320px;
  max-height: min(70vh, 480px);
  overflow-y: auto;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};

  ${mobile} {
    position: fixed;
    top: ${({ theme }) => theme.layout.headerHeight};
    right: 8px;
    left: 8px;
    width: auto;
  }
`

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.text};

  & > button {
    border: 0;
    background: none;
    color: ${({ theme }) => theme.colors.primary};
    font-size: 13px;
    font-weight: 600;
  }
  & > button:disabled { color: ${({ theme }) => theme.colors.textMuted}; }
`

const Item = styled.button<{ $unread: boolean }>`
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme, $unread }) => ($unread ? theme.colors.primarySoft : 'transparent')};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  font-weight: ${({ $unread }) => ($unread ? 600 : 400)};
  text-align: left;

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
  & > small { color: ${({ theme }) => theme.colors.textMuted}; font-size: 12px; font-weight: 400; }
`

const Empty = styled.p`
  margin: 0;
  padding: 16px 12px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 14px;
`

export function NotificationBell({
  notifications,
  onRead,
}: {
  notifications: NotificationsView
  /** Marks these read, or all of them */
  onRead: (ids?: string[]) => void
}) {
  const { t, lang } = usePreferences()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const { items, unread } = notifications

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <Wrap ref={wrap}>
      <BellButton
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.unreadNotifications(unread)}
        title={t.unreadNotifications(unread)}
      >
        <Bell size={18} aria-hidden />
        {unread > 0 && <b aria-hidden>{unread > 99 ? '99+' : unread}</b>}
      </BellButton>
      {open && (
        <Panel role="dialog" aria-label={t.notifications}>
          <Head>
            <strong>{t.notifications}</strong>
            <button type="button" disabled={unread === 0} onClick={() => onRead()}>
              {t.markAllRead}
            </button>
          </Head>
          {items.length === 0 ? (
            <Empty>{t.noNotifications}</Empty>
          ) : (
            items.map((n) => (
              <Item
                key={n.id}
                type="button"
                $unread={!n.read}
                onClick={() => {
                  if (!n.read) onRead([n.id])
                  setOpen(false)
                  navigate(notificationLink(n))
                }}
              >
                <span>{notificationText(t, n)}</span>
                <small>{formatDateTime(n.at, lang)}</small>
              </Item>
            ))
          )}
        </Panel>
      )}
    </Wrap>
  )
}
