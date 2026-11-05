import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import styled from 'styled-components'
import { AppHeader } from './components/AppHeader.tsx'
import { TOAST_TIMEOUT, ToastProvider, useToast } from './components/Toast.tsx'
import { Muted, PageMain } from './components/ui.tsx'
import { useClubSounds } from './lib/sound/hooks.ts'
import { AccountPage } from './pages/AccountPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { BoardPage } from './pages/BoardPage.tsx'
import { ChallengeBoardPage } from './pages/ChallengeBoardPage.tsx'
import { ChallengePage } from './pages/ChallengePage.tsx'
import { ChallengesPage } from './pages/ChallengesPage.tsx'
import { ClubApplyPage } from './pages/ClubApplyPage.tsx'
import { ChallengeStatsPage } from './pages/ChallengeStatsPage.tsx'
import { DailyPage } from './pages/DailyPage.tsx'
import { PairsEventPage, PairsListPage } from './pages/PairsPages.tsx'
import { PartnerBiddingListPage, PartnerBiddingPage, PartnerBidReviewPage } from './pages/PartnerBiddingPages.tsx'
import { TournamentPage, TournamentsListPage } from './pages/TournamentPages.tsx'
import { TeamEventPage } from './pages/TeamEventPage.tsx'
import { RankingsPage } from './pages/RankingsPage.tsx'
import { ComparePage } from './pages/ComparePage.tsx'
import { FeaturedPage } from './pages/FeaturedPage.tsx'
import { FavoritesPage } from './pages/FavoritesPage.tsx'
import { ForumBoardPage, ForumDraftsPage, ForumHomePage, ForumPostPage } from './pages/ForumPages.tsx'
import { ForumEditPostPage, ForumNewPostPage } from './pages/ForumEditorPage.tsx'
import { ForumReportsPage, ForumSearchPage } from './pages/ForumModerationPages.tsx'
import { HistoryPage } from './pages/HistoryPage.tsx'
import { LobbyPage } from './pages/LobbyPage.tsx'
import { LegalPage } from './pages/LegalPage.tsx'
import { EmailLinkPage } from './pages/EmailLinkPage.tsx'
import { LoginPage } from './pages/LoginPage.tsx'
import { MatchesPage } from './pages/MatchesPage.tsx'
import { MatchPage } from './pages/MatchPage.tsx'
import { MatchReplayPage } from './pages/MatchReplayPage.tsx'
import { VugraphPage } from './pages/VugraphPage.tsx'
import { PlatformPage } from './pages/PlatformPage.tsx'
import { ProfilePage } from './pages/ProfilePage.tsx'
import { GuestTablePage, PublicLobbyPage } from './pages/PublicLobbyPage.tsx'
import { SharedBoardPage } from './pages/SharedBoardPage.tsx'
import { TablePage } from './pages/TablePage.tsx'
import { AuthProvider, useAuth, useFeature } from './state/AuthContext.tsx'
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

/** A `/c/<id>/` address of a club the site does not have (e12-t04) */
function MissingClub() {
  const { t } = usePreferences()
  return (
    <PageMain>
      <Muted role="alert">{t.clubs.missing}</Muted>
      <p>
        <a href="/">{t.clubs.toHome}</a>
      </p>
    </PageMain>
  )
}

function Routed() {
  const { user, missingClub } = useAuth()
  const { t } = usePreferences()
  const { pathname } = useLocation()
  // The forum's pages only for members who have the flag (E13 K1, shared/features.ts)
  const forumOn = useFeature('forum')
  // Pairs events (E9 J3, §5.22) behind their flag
  const pairsOn = useFeature('pairs')
  const rankingsOn = useFeature('rankings')
  const tournamentsOn = useFeature('tournaments')
  // The cross-club lobby (e12-t07) behind its flag
  const publicLobbyOn = useFeature('publicLobby')
  if (missingClub) return <MissingClub />
  // The privacy policy and the terms are for anyone, signed in or not (e11-t27)
  if (pathname === '/privacy' || pathname === '/terms') return <LegalPage kind={pathname === '/privacy' ? 'privacy' : 'terms'} />
  // The email links (e1-t29, e1-t30) work signed in or not, on any device
  if (pathname === '/email/verify' || pathname === '/email/reset') return <EmailLinkPage kind={pathname === '/email/verify' ? 'verify' : 'reset'} />
  // Applying for a club of one's own (e12-t06) is for anyone, signed in or not
  if (pathname === '/clubs/apply') return <ClubApplyPage />
  // A board's public link (e4-t38) is for anyone, signed in or not
  if (pathname.startsWith('/share/'))
    return (
      <Routes>
        <Route path="/share/:token" element={<SharedBoardPage />} />
      </Routes>
    )
  if (user === undefined) return <PageMain>{t.loading}</PageMain>
  if (user === null) return <LoginPage />
  return (
    <>
      <ConnectionBanner />
      <Routes>
        <Route path="/" element={<LobbyPage />} />
        <Route path="/table/:tableId" element={<TablePage />} />
        <Route path="/challenges" element={<ChallengesPage />} />
        <Route path="/challenges/stats" element={<ChallengeStatsPage />} />
        <Route path="/daily" element={<DailyPage />} />
        {(rankingsOn || user.admin) && <Route path="/rankings" element={<RankingsPage />} />}
        <Route path="/challenges/:challengeId" element={<ChallengePage />} />
        <Route path="/challenges/:challengeId/boards/:seq" element={<ChallengeBoardPage />} />
        <Route path="/partner-bidding" element={<PartnerBiddingListPage />} />
        <Route path="/partner-bidding/:sessionId" element={<PartnerBiddingPage />} />
        <Route path="/partner-bidding/:sessionId/boards/:seq" element={<PartnerBidReviewPage />} />
        <Route path="/matches" element={<MatchesPage />} />
        <Route path="/matches/:matchId" element={<MatchPage />} />
        <Route path="/matches/:matchId/vugraph" element={<VugraphPage />} />
        <Route path="/matches/:matchId/replay" element={<MatchReplayPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/history/:recordId" element={<BoardPage />} />
        <Route path="/history/:recordId/vs/:otherId" element={<ComparePage />} />
        <Route path="/featured" element={<FeaturedPage />} />
        <Route path="/favorites" element={<FavoritesPage />} />
        {pairsOn && <Route path="/pairs" element={<PairsListPage />} />}
        {/* A pairs event made from a tournament (e9-t16) is played by members without the flag: the server decides who sees it */}
        <Route path="/pairs/:eventId" element={<PairsEventPage />} />
        {(tournamentsOn || user.admin) && <Route path="/tournaments" element={<TournamentsListPage />} />}
        {(tournamentsOn || user.admin) && <Route path="/tournaments/:tournamentId" element={<TournamentPage />} />}
        {/* Its teams reach it without the flag too: the server decides (e9-t14) */}
        <Route path="/team-events/:eventId" element={<TeamEventPage />} />
        {forumOn && <Route path="/forum" element={<ForumHomePage />} />}
        {forumOn && <Route path="/forum/new" element={<ForumNewPostPage />} />}
        {forumOn && <Route path="/forum/search" element={<ForumSearchPage />} />}
        {forumOn && <Route path="/forum/reports" element={<ForumReportsPage />} />}
        {forumOn && <Route path="/forum/drafts" element={<ForumDraftsPage />} />}
        {forumOn && <Route path="/forum/p/:postId" element={<ForumPostPage />} />}
        {forumOn && <Route path="/forum/p/:postId/edit" element={<ForumEditPostPage />} />}
        {forumOn && <Route path="/forum/:boardId" element={<ForumBoardPage />} />}
        {publicLobbyOn && <Route path="/clubs" element={<PublicLobbyPage />} />}
        {publicLobbyOn && <Route path="/clubs/:clubId/:tableId" element={<GuestTablePage />} />}
        <Route path="/account" element={<AccountPage />} />
        <Route path="/members/:userId" element={<ProfilePage />} />
        {user.admin && <Route path="/admin" element={<AdminPage />} />}
        {user.platformOwner && <Route path="/platform" element={<PlatformPage />} />}
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
