import {
  Check,
  ChevronDown,
  Globe,
  History,
  Star,
  Layers,
  List,
  LogOut,
  Moon,
  Palette,
  Shield,
  Sun,
  Swords,
  UserRound,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import styled from 'styled-components'
import { LANGS } from '../../shared/messages.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { LANG_NAMES } from '../strings.ts'
import { mobile } from '../styles/tokens.ts'
import { LogoMark, LogoWordmark } from './Logo.tsx'
import { NotificationBell } from './NotificationBell.tsx'

const Bar = styled.header`
  position: sticky;
  min-width: 0;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 12px;
  height: ${({ theme }) => theme.layout.headerHeight};
  padding: 0 16px;

  ${mobile} {
    gap: 4px;
    padding: 0 8px;
  }
  background: ${({ theme }) => theme.colors.header};
  color: ${({ theme }) => theme.colors.onHeader};
`

const Brand = styled(NavLink)`
  display: flex;
  align-items: center;
  gap: 9px;
  color: ${({ theme }) => theme.colors.onHeader};
  text-decoration: none;
  font-weight: 700;
  white-space: nowrap;

  ${mobile} {
    & > span { display: none; }
  }
`

const Nav = styled.nav`
  display: flex;
  align-self: stretch;
  gap: 4px;
  margin-left: 8px;
`

/** Registrations waiting for approval, next to 管理 */
const Count = styled.b`
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: ${({ theme }) => theme.radius.pill};
  background: ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.header};
  font-size: 11px;
  font-weight: 800;
  line-height: 1;
`

/** A page link: muted on navy; the current page is off-white with a lantern-gold rule under it */
const Link = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: stretch;
  padding: 3px 10px 0;
  border-bottom: 3px solid transparent;
  color: ${({ theme }) => theme.colors.headerMuted};
  text-decoration: none;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;

  ${mobile} {
    & > span { display: none; }
  }

  &:hover { color: ${({ theme }) => theme.colors.onHeader}; background: ${({ theme }) => theme.colors.headerHover}; }

  &.active {
    border-bottom-color: ${({ theme }) => theme.colors.accent};
    color: ${({ theme }) => theme.colors.onHeader};
  }
`

const Right = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;

  /* Theme, deck colours and sound stay on the account page on a phone */
  ${mobile} {
    gap: 0;
    & > [data-wide-only] { display: none; }
  }
`

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: transparent;
  color: ${({ theme }) => theme.colors.headerMuted};

  &:hover {
    background: ${({ theme }) => theme.colors.headerHover};
    color: ${({ theme }) => theme.colors.onHeader};
  }
`

const Who = styled.span`
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ theme }) => theme.colors.onHeader};
  font-size: 14px;
  font-weight: 600;

  ${mobile} { display: none; }
`

const Dot = styled.span<{ $ok: boolean }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ $ok, theme }) => ($ok ? theme.colors.success : theme.colors.lantern)};
`

const MenuWrap = styled.div`
  position: relative;
`

const LangButton = styled(IconButton)`
  gap: 4px;
  width: auto;
  padding: 0 8px;
  font-size: 13px;
  font-weight: 700;

  ${mobile} {
    & > span, & > svg + span + svg { display: none; }
  }
`

const Menu = styled.div`
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  display: grid;
  min-width: 170px;
  padding: 6px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  box-shadow: ${({ theme }) => theme.shadowRaised};
`

const MenuItem = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 10px;
  border: 0;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: none;
  color: ${({ theme }) => theme.colors.text};
  font-size: 15px;
  text-align: left;

  & > svg { flex: none; color: ${({ theme }) => theme.colors.primary}; }
  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
  &[aria-checked='true'] { font-weight: 700; color: ${({ theme }) => theme.colors.primary}; }
`

/** The language menu: a globe button that opens the list of languages, each in its own name */
function LanguageMenu() {
  const { lang, set, t } = usePreferences()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

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
    <MenuWrap ref={wrap}>
      <LangButton
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t.languageLabel}
        title={t.languageLabel}
      >
        <Globe size={18} aria-hidden />
        <span>{LANG_NAMES[lang].short}</span>
        <ChevronDown size={14} aria-hidden />
      </LangButton>
      {open && (
        <Menu role="menu" aria-label={t.languageLabel}>
          {LANGS.map((code) => (
            <MenuItem
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === lang}
              onClick={() => {
                set({ lang: code })
                setOpen(false)
              }}
            >
              {code === lang ? <Check size={16} aria-hidden /> : <span style={{ width: 16 }} aria-hidden />}
              {LANG_NAMES[code].name}
            </MenuItem>
          ))}
        </Menu>
      )}
    </MenuWrap>
  )
}

export function AppHeader() {
  const { user, logout } = useAuth()
  const { status, notifications, send } = useClub()
  const { mode, deck, cardStyle, sound, t, toggleMode, toggleDeck, toggleCardStyle, toggleSound } = usePreferences()

  return (
    <Bar>
      <Brand to="/" aria-label={`${t.appNameEn} ${t.appNameZh}`}>
        <LogoMark size={42} />
        <LogoWordmark />
      </Brand>
      {user && (
        <Nav aria-label={t.navLobby}>
          <Link to="/" end aria-label={t.navLobby}>
            <Users size={18} aria-hidden />
            <span>{t.navLobby}</span>
          </Link>
          <Link to="/challenges" aria-label={t.navChallenges}>
            <Swords size={18} aria-hidden />
            <span>{t.navChallenges}</span>
          </Link>
          <Link to="/history" aria-label={t.navHistory}>
            <History size={18} aria-hidden />
            <span>{t.navHistory}</span>
          </Link>
          <Link to="/favorites" aria-label={t.navFavorites}>
            <Star size={18} aria-hidden />
            <span>{t.navFavorites}</span>
          </Link>
          {user.admin && (
            <Link
              to="/admin"
              aria-label={user.applications ? `${t.navAdmin}（${t.navAdminPending(user.applications)}）` : t.navAdmin}
            >
              <Shield size={18} aria-hidden />
              <span>{t.navAdmin}</span>
              {!!user.applications && <Count aria-hidden>{user.applications}</Count>}
            </Link>
          )}
        </Nav>
      )}
      <Right>
        <LanguageMenu />
        <IconButton
          type="button"
          data-wide-only
          onClick={toggleSound}
          aria-label={sound ? t.soundOff : t.soundOn}
          title={sound ? t.soundOff : t.soundOn}
        >
          {sound ? <Volume2 size={18} aria-hidden /> : <VolumeX size={18} aria-hidden />}
        </IconButton>
        <IconButton
          type="button"
          onClick={toggleCardStyle}
          aria-label={cardStyle === 'cards' ? t.styleToText : t.styleToCards}
          title={cardStyle === 'cards' ? t.styleToText : t.styleToCards}
        >
          {cardStyle === 'cards' ? <List size={18} aria-hidden /> : <Layers size={18} aria-hidden />}
        </IconButton>
        <IconButton
          type="button"
          data-wide-only
          onClick={toggleDeck}
          aria-label={deck === 'two' ? t.deckToFour : t.deckToTwo}
          title={deck === 'two' ? t.deckToFour : t.deckToTwo}
        >
          <Palette size={18} aria-hidden />
        </IconButton>
        <IconButton
          type="button"
          data-wide-only
          onClick={toggleMode}
          aria-label={mode === 'light' ? t.themeToDark : t.themeToLight}
          title={mode === 'light' ? t.themeToDark : t.themeToLight}
        >
          {mode === 'light' ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
        </IconButton>
        {user && (
          <>
            {notifications && (
              <NotificationBell notifications={notifications} onRead={(ids) => send({ type: 'readNotifications', ids })} />
            )}
            <Dot
              $ok={status === 'open'}
              role="status"
              aria-label={status === 'open' ? t.connected : t.connecting}
              title={status === 'open' ? t.connected : t.connecting}
            />
            <AccountLink to="/account" title={t.navAccount}>
              <UserRound size={16} aria-hidden />
              <Who>{user.username}</Who>
            </AccountLink>
            <IconButton type="button" onClick={() => void logout()} aria-label={t.logout} title={t.logout}>
              <LogOut size={18} aria-hidden />
            </IconButton>
          </>
        )}
      </Right>
    </Bar>
  )
}

const AccountLink = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 0 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.headerMuted};
  text-decoration: none;
  &:hover, &.active { background: ${({ theme }) => theme.colors.headerHover}; }
`
