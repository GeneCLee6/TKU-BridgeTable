import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import styled from 'styled-components'
import { AppHeader } from './components/AppHeader.tsx'
import { PageMain } from './components/ui.tsx'
import { AccountPage } from './pages/AccountPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { BoardPage } from './pages/BoardPage.tsx'
import { ChallengePage } from './pages/ChallengePage.tsx'
import { ChallengesPage } from './pages/ChallengesPage.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { LobbyPage } from './pages/LobbyPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { TablePage } from './pages/TablePage.tsx'
import { AuthProvider, useAuth } from './state/AuthContext.tsx'
import { ClubProvider, useClub } from './state/ClubContext.tsx'
import { PreferencesProvider, usePreferences } from './state/PreferencesContext.tsx'
import { GlobalStyle } from './styles/GlobalStyle.ts'

const Toast = styled.div`
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 50;
  transform: translateX(-50%);
  max-width: calc(100% - 32px);
  padding: 10px 16px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.colors.danger};
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
`

const Banner = styled.div`
  padding: 6px 16px;
  background: ${({ theme }) => theme.colors.lantern};
  color: #1a2233;
  font-size: 14px;
  text-align: center;
`

/** Server errors (an illegal call, a taken seat) appear briefly at the bottom, in the viewer's language */
function ErrorToast() {
  const { error, dismissError } = useClub()
  const { message } = usePreferences()
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(dismissError, 4000)
    return () => clearTimeout(timer)
  }, [error, dismissError])
  return error ? (
    <Toast role="alert" onClick={dismissError}>
      {message(error.code, error.params, error.message)}
    </Toast>
  ) : null
}

function ConnectionBanner() {
  const { status, lobby } = useClub()
  const { t } = usePreferences()
  return status !== 'open' && lobby !== null ? <Banner role="status">{t.reconnecting}</Banner> : null
}

function Routed() {
  const { user } = useAuth()
  const { t } = usePreferences()
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
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:recordId" element={<BoardPage />} />
        <Route path="/account" element={<AccountPage />} />
        {user.admin && <Route path="/admin" element={<AdminPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <ErrorToast />
    </>
  )
}

export function App() {
  return (
    <PreferencesProvider>
      <GlobalStyle />
      <AuthProvider>
        <ClubProvider>
          <AppHeader />
          <Routed />
        </ClubProvider>
      </AuthProvider>
    </PreferencesProvider>
  )
}
