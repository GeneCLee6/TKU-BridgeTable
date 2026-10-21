import { History, LogOut, Moon, Palette, Sun, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import styled from 'styled-components'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile } from '../styles/tokens.ts'
import { strings } from '../strings.ts'
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

export function AppHeader() {
  const { user, logout } = useAuth()
  const { status } = useClub()
  const { mode, deck, toggleMode, toggleDeck } = usePreferences()

  return (
    <Bar>
      <Brand to="/" aria-label={`${strings.appNameEn} ${strings.appNameZh}`}>
        <LogoMark size={34} />
        <span>
          {strings.appNameEn} · {strings.appNameZh}
        </span>
      </Brand>
      {user && (
        <Nav aria-label="主選單">
          <Link to="/" end aria-label={strings.navLobby}>
            <Users size={18} aria-hidden />
            <span>{strings.navLobby}</span>
          </Link>
          <Link to="/history" aria-label={strings.navHistory}>
            <History size={18} aria-hidden />
            <span>{strings.navHistory}</span>
          </Link>
        </Nav>
      )}
      <Right>
        <IconButton
          type="button"
          onClick={toggleDeck}
          aria-label={deck === 'two' ? strings.deckToFour : strings.deckToTwo}
          title={deck === 'two' ? strings.deckToFour : strings.deckToTwo}
        >
          <Palette size={18} aria-hidden />
        </IconButton>
        <IconButton
          type="button"
          onClick={toggleMode}
          aria-label={mode === 'light' ? strings.themeToDark : strings.themeToLight}
          title={mode === 'light' ? strings.themeToDark : strings.themeToLight}
        >
          {mode === 'light' ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
        </IconButton>
        {user && (
          <>
            <Dot
              $ok={status === 'open'}
              role="status"
              aria-label={status === 'open' ? '已連線' : strings.connecting}
              title={status === 'open' ? '已連線' : strings.connecting}
            />
            <Who>{user.username}</Who>
            <IconButton type="button" onClick={() => void logout()} aria-label={strings.logout} title={strings.logout}>
              <LogOut size={18} aria-hidden />
            </IconButton>
          </>
        )}
      </Right>
    </Bar>
  )
}
