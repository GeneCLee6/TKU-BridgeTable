import { History, Layers, List, LogOut, Moon, Palette, Shield, Sun, UserRound, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import styled from 'styled-components'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { LogoMark } from './Logo.tsx'

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
  background: ${({ theme }) => theme.colors.surface};
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  color: ${({ theme }) => theme.colors.primary};
`

const Brand = styled(NavLink)`
  display: flex;
  align-items: center;
  gap: 8px;
  color: ${({ theme }) => theme.colors.primaryStrong};
  text-decoration: none;
  font-weight: 700;
  white-space: nowrap;

  ${mobile} {
    & > span { display: none; }
  }
`

const Nav = styled.nav`
  display: flex;
  gap: 4px;
  margin-left: 8px;
`

const Link = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;

  ${mobile} {
    & > span { display: none; }
  }

  &.active {
    background: ${({ theme }) => theme.colors.primarySoft};
    color: ${({ theme }) => theme.colors.primary};
  }
`

const Right = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;

  /* Theme and deck colours stay on the account page on a phone */
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
  color: ${({ theme }) => theme.colors.textMuted};

  &:hover { background: ${({ theme }) => theme.colors.surfaceAlt}; }
`

const Who = styled.span`
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ theme }) => theme.colors.text};
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

const LangButton = styled(IconButton)`
  width: auto;
  padding: 0 8px;
  font-size: 13px;
  font-weight: 700;
`

export function AppHeader() {
  const { user, logout } = useAuth()
  const { status } = useClub()
  const { mode, deck, cardStyle, t, toggleMode, toggleDeck, toggleCardStyle, toggleLang } = usePreferences()

  return (
    <Bar>
      <Brand to="/" aria-label={`${t.appNameEn} ${t.appNameZh}`}>
        <LogoMark size={34} />
        <span>
          {t.appNameEn} · {t.appNameZh}
        </span>
      </Brand>
      {user && (
        <Nav aria-label={t.navLobby}>
          <Link to="/" end aria-label={t.navLobby}>
            <Users size={18} aria-hidden />
            <span>{t.navLobby}</span>
          </Link>
          <Link to="/history" aria-label={t.navHistory}>
            <History size={18} aria-hidden />
            <span>{t.navHistory}</span>
          </Link>
          {user.admin && (
            <Link to="/admin" aria-label={t.navAdmin}>
              <Shield size={18} aria-hidden />
              <span>{t.navAdmin}</span>
            </Link>
          )}
        </Nav>
      )}
      <Right>
        <LangButton type="button" onClick={toggleLang} aria-label={t.languageLabel} title={t.languageLabel}>
          {t.language}
        </LangButton>
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
  color: ${({ theme }) => theme.colors.textMuted};
  text-decoration: none;
  &.active { background: ${({ theme }) => theme.colors.primarySoft}; }
`
