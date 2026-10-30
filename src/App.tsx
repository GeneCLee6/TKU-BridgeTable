import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { AppHeader } from './components/AppHeader.tsx'
import { TOAST_TIMEOUT, ToastProvider, useToast } from './components/Toast.tsx'
import { PageMain } from './components/ui.tsx'
import { useClubSounds } from './lib/sound/hooks.ts'
import { AccountPage } from './pages/AccountPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { BoardPage } from './pages/BoardPage.tsx'
import { ChallengeBoardPage } from './pages/ChallengeBoardPage.tsx'
import { ChallengePage } from './pages/ChallengePage.tsx'
import { ChallengesPage } from './pages/ChallengesPage.tsx'
import { ComparePage } from './pages/ComparePage.tsx'
import { FeaturedPage } from './pages/FeaturedPage.tsx'
import { FavoritesPage } from './pages/FavoritesPage.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { LobbyPage } from './pages/LobbyPage.tsx'
import { LegalPage } from './pages/LegalPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { MatchesPage } from './pages/MatchesPage.tsx'
import { MatchPage } from './pages/MatchPage.tsx'
import { MatchReplayPage } from './pages/MatchReplayPage.tsx'
import { VugraphPage } from './pages/VugraphPage.tsx'
import { ProfilePage } from './pages/ProfilePage.tsx'
import { TablePage } from './pages/TablePage.tsx'
import { AuthProvider, useAuth } from './state/AuthContext.tsx'
import { ClubProvider, useClub } from './state/ClubContext.tsx'
import { InvitationsProvider } from './state/InvitationsContext.tsx'
import { PreferencesProvider, usePreferences } from './state/PreferencesContext.tsx'
import { GlobalStyle } from './styles/GlobalStyle.ts'

const Banner = styled.div`
  padding: 6px 16px;
  background: ${({ theme }) => theme.colors.accentSoft};
  border-bottom: 1px solid ${({ theme }) => theme.colors.accent};
  color: ${({ theme }) => theme.colors.text};
  font-size: 14px;
  text-align: center;
`

/**
 * Server errors (an illegal call, a taken seat) become an error toast in the viewer's language.
 * They are about a move just tried, so unlike other errors they close themselves, as before.
 */
function ServerErrorToast() {
  const { error, dismissError } = useClub()
  const { message } = usePreferences()
  const toast = useToast()
  useEffect(() => {
    if (!error) return
    toast.error(message(error.code, error.params, error.message), { timeout: TOAST_TIMEOUT })
    dismissError()
  }, [error, dismissError, message, toast])
  return null
}

/** The sounds outside a table: notifications, direct messages, and unlocking audio on the first gesture */
function ClubSounds() {
  const { user } = useAuth()
  const { notifications, directLive } = useClub()
  useClubSounds({ userId: user?.id, notifications, directs: directLive })
  return null
}

function ConnectionBanner() {
  const { status, lobby } = useClub()
  const { t } = usePreferences()
  return status !== 'open' && lobby !== null ? <Banner role="status">{t.reconnecting}</Banner> : null
}

function Routed() {
  const { user } = useAuth()
  const { t } = usePreferences()
  const { pathname } = useLocation()
  // The privacy policy and the terms are for anyone, signed in or not (e11-t27)
  if (pathname === '/privacy' || pathname === '/terms') return <LegalPage kind={pathname === '/privacy' ? 'privacy' : 'terms'} />
  if (user === undefined) return <PageMain>{t.loading}</PageMain>
  if (user === null) return <LoginPage />
  return (
    <>
      <ConnectionBanner />
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/table/:tableId" element={<TablePage />} />
        <Route path="/challenges" element={<ChallengesPage />} />
        <Route path="/challenges/:challengeId" element={<ChallengePage />} />
        <Route path="/challenges/:challengeId/boards/:seq" element={<ChallengeBoardPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/matches/:matchId" element={<MatchPage />} />
        <Route path="/matches/:matchId/vugraph" element={<VugraphPage />} />
        <Route path="/matches/:matchId/replay" element={<MatchReplayPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:recordId" element={<BoardPage />} />
        <Route path="/history/:recordId/vs/:otherId" element={<ComparePage />} />
        <Route path="/featured" element={<FeaturedPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/members/:userId" element={<ProfilePage />} />
        {user.admin && <Route path="/admin" element={<AdminPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ServerErrorToast />
      <ClubSounds />
    </>
  )
}

export function App() {
  return (
    <PreferencesProvider>
      <GlobalStyle />
      <ToastProvider>
        <AuthProvider>
          <ClubProvider>
            <InvitationsProvider>
              <AppHeader />
              <Routed />
            </InvitationsProvider>
          </ClubProvider>
        </AuthProvider>
      </ToastProvider>
    </PreferencesProvider>
  )
}
