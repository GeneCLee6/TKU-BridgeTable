import {
  Award,
  Building2,
  Check,
  ChevronDown,
  Flag,
  Globe,
  History,
  LogOut,
  Medal,
  MessagesSquare,
  Moon,
  Shield,
  Star,
  Sun,
  Swords,
  Trophy,
  Users,
  UsersRound,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { DEFAULT_CLUB_ID } from '../../shared/clubs.ts'
import { LANGS } from '../../shared/messages.ts'
import { CLUB_APPLY_PAGE } from '../../shared/platform.ts'
import { LANDING_PAGE } from '../../shared/site.ts'
import { currentClub } from '../lib/club.ts'
import { useClubBrand } from '../lib/useClubName.ts'
import { useAuth, useFeature } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { useInviteBanner } from '../state/InvitationsContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { LANG_NAMES } from '../strings.ts'
import { compactHeader, mobile, tablet } from '../styles/tokens.ts'
import { Avatar } from './Avatar.tsx'
import { PartBoundary } from './ErrorBoundary.tsx'
import { ClubMark, OvertrickMark, OvertrickName, OvertrickWordmark, TamkangMark } from './Logo.tsx'
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

const Brand = styled.div`
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  white-space: nowrap;

  ${mobile} { gap: 4px; }
`

/** The club's mark, leading home to the club */
const ClubHome = styled(NavLink)`
  display: flex;
  color: ${({ theme }) => theme.colors.onHeader};
`

/** The club's name, and under it the platform's; the words give way to the marks when room is short */
const Names = styled.span`
  display: grid;
  gap: 1px;
  line-height: 1.1;
  font-weight: 700;

  ${compactHeader} { display: none; }
`

const ClubNameLink = styled(NavLink)`
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: ${({ theme }) => theme.colors.onHeader};
  font-size: 15px;
  text-decoration: none;
`

/** "Overtrick" under the club's name: the platform this club is on, leading to its page */
const PlatformLink = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: ${({ theme }) => theme.colors.headerMuted};
  text-decoration: none;

  &:hover { color: ${({ theme }) => theme.colors.onHeader}; }
`

/** When the words are gone, the platform's mark alone stays beside the club's */
const PlatformMarkLink = styled(PlatformLink)`
  display: none;
  ${compactHeader} { display: inline-flex; }
`

/** The platform alone: a visitor at the plain address, on a page that is no club's */
const PlatformBrand = styled(NavLink)`
  display: flex;
  color: ${({ theme }) => theme.colors.onHeader};
`

const Nav = styled.nav`
  display: flex;
  align-self: stretch;
  gap: 4px;
  margin-left: 8px;

  /* A phone has no room for every link: they scroll sideways instead of widening the page */
  ${mobile} {
    flex: 0 1 auto;
    min-width: 0;
    gap: 0;
    margin-left: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }
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

  /* On a tablet or a phone the links are icons, named by their aria-label and title */
  ${tablet} {
    padding: 3px 12px 0;
    & > span { display: none; }
  }

  ${mobile} {
    padding: 3px 9px 0;
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
  flex: none;
  margin-left: auto;

  /* Theme and sound stay on the account page on a phone */
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

  ${tablet} { display: none; }
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

const PLATFORM_PAGES = [LANDING_PAGE, CLUB_APPLY_PAGE, '/privacy', '/terms']

export function AppHeader() {
  const { user, logout } = useAuth()
  // The forum's link only for members who have the flag (E13 K1)
  const forumOn = useFeature('forum')
  // Pairs events' link only with their flag (E9 J3)
  const pairsOn = useFeature('pairs')
  // The rankings' link (J2): members with the flag, and admins, who set the rules first
  const rankingsOn = useFeature('rankings')
  const tournamentsOn = useFeature('tournaments')
  // The cross-club lobby (e12-t07)
  const publicLobbyOn = useFeature('publicLobby')
  const { status, notifications, send } = useClub()
  const inviteBanner = useInviteBanner()
  const { mode, sound: soundOn, soundStyle, t, toggleMode, toggleSound } = usePreferences()
  // A style set to 關閉 on the account page shows as off here too
  const sound = soundOn && soundStyle !== 'off'
  const { pathname } = useLocation()
  const { name: clubName, logo: clubLogo } = useClubBrand()
  // Signed out at the plain address, the pages anyone may read belong to the platform, not to 淡江
  const platformOnly = !user && currentClub() === DEFAULT_CLUB_ID && (PLATFORM_PAGES.includes(pathname) || pathname.startsWith('/share/'))

  return (
    <Bar>
      {platformOnly ? (
        <PlatformBrand to={LANDING_PAGE}>
          <OvertrickWordmark height={20} />
        </PlatformBrand>
      ) : (
        <Brand>
          <ClubHome to="/" end aria-label={clubName}>
            {currentClub() === DEFAULT_CLUB_ID ? <TamkangMark size={42} /> : <ClubMark name={clubName} logo={clubLogo} size={36} />}
          </ClubHome>
          <Names>
            <ClubNameLink to="/" end tabIndex={-1} aria-hidden>
              {clubName}
            </ClubNameLink>
            <PlatformLink to={LANDING_PAGE} aria-label={t.landing.link} title={t.landing.link}>
              <OvertrickMark size={14} />
              <OvertrickName height={11} />
            </PlatformLink>
          </Names>
          <PlatformMarkLink to={LANDING_PAGE} aria-label={t.landing.link} title={t.landing.link}>
            <OvertrickMark size={22} />
          </PlatformMarkLink>
        </Brand>
      )}
      {user && (
        <Nav aria-label={t.navLobby}>
          <Link to="/" end aria-label={t.navLobby} title={t.navLobby}>
            <Users size={18} aria-hidden />
            <span>{t.navLobby}</span>
          </Link>
          <Link to="/challenges" aria-label={t.navChallenges} title={t.navChallenges}>
            <Swords size={18} aria-hidden />
            <span>{t.navChallenges}</span>
          </Link>
          <Link to="/matches" aria-label={t.navMatches} title={t.navMatches}>
            <Trophy size={18} aria-hidden />
            <span>{t.navMatches}</span>
          </Link>
          {pairsOn && (
            <Link to="/pairs" aria-label={t.pairs.title} title={t.pairs.title}>
              <UsersRound size={18} aria-hidden />
              <span>{t.pairs.title}</span>
            </Link>
          )}
          {tournamentsOn && (
            <Link to="/tournaments" aria-label={t.tournaments.title} title={t.tournaments.title}>
              <Flag size={18} aria-hidden />
              <span>{t.tournaments.title}</span>
            </Link>
          )}
          <Link to="/history" aria-label={t.navHistory} title={t.navHistory}>
            <History size={18} aria-hidden />
            <span>{t.navHistory}</span>
          </Link>
          <Link to="/featured" aria-label={t.navFeatured} title={t.navFeatured}>
            <Award size={18} aria-hidden />
            <span>{t.navFeatured}</span>
          </Link>
          <Link to="/favorites" aria-label={t.navFavorites} title={t.navFavorites}>
            <Star size={18} aria-hidden />
            <span>{t.navFavorites}</span>
          </Link>
          {(rankingsOn || user.admin) && (
            <Link to="/rankings" aria-label={t.rankings.nav} title={t.rankings.nav}>
              <Medal size={18} aria-hidden />
              <span>{t.rankings.nav}</span>
            </Link>
          )}
          {forumOn && (
            <Link to="/forum" aria-label={t.navForum} title={t.navForum}>
              <MessagesSquare size={18} aria-hidden />
              <span>{t.navForum}</span>
            </Link>
          )}
          {publicLobbyOn && (
            <Link to="/clubs" aria-label={t.clubs.lobbyLink} title={t.clubs.lobbyLink}>
              <Building2 size={18} aria-hidden />
              <span>{t.clubs.lobbyLink}</span>
            </Link>
          )}
          {user.admin && (
            <Link
              to="/admin"
              title={t.navAdmin}
              aria-label={user.applications ? `${t.navAdmin}（${t.navAdminPending(user.applications)}）` : t.navAdmin}
            >
              <Shield size={18} aria-hidden />
              <span>{t.navAdmin}</span>
              {!!user.applications && <Count aria-hidden>{user.applications}</Count>}
            </Link>
          )}
          {/* The platform's back office (e12-t05): its owner only, and the server checks again */}
          {user.platformOwner && (
            <Link to="/platform" title={t.platform.link} aria-label={t.platform.link}>
              <Building2 size={18} aria-hidden />
              <span>{t.platform.link}</span>
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
          data-wide-only
          onClick={toggleMode}
          aria-label={mode === 'light' ? t.themeToDark : t.themeToLight}
          title={mode === 'light' ? t.themeToDark : t.themeToLight}
        >
          {mode === 'light' ? <Moon size={18} aria-hidden /> : <Sun size={18} aria-hidden />}
        </IconButton>
        {user && (
          <>
            <PartBoundary name="invite-banner">{inviteBanner}</PartBoundary>
            {notifications && (
              <PartBoundary name="notification-bell">
                <NotificationBell notifications={notifications} onRead={(ids) => send({ type: 'readNotifications', ids })} />
              </PartBoundary>
            )}
            <Dot
              $ok={status === 'open'}
              role="status"
              aria-label={status === 'open' ? t.connected : t.connecting}
              title={status === 'open' ? t.connected : t.connecting}
            />
            <AccountLink to="/account" title={t.navAccount}>
              <Avatar id={user.id} name={user.profile?.displayName || user.username} size={24} avatar={user.avatar} />
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
