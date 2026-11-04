import '@fontsource-variable/noto-sans-tc'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.tsx'
import { clubBase, linkClubManifest, plainAddress, setClubFromPath } from './lib/club.ts'
import { setUpErrorReporting } from './lib/errorReport.ts'
import { setUpApp } from './lib/pwa.ts'

// The club comes from the address (e12-t04): 淡江 at the plain one (`/c/tku/…` goes there), any
// other club under `/c/<id>/`, where every page of the app stays
const plain = plainAddress(window.location.pathname, window.location.search, window.location.hash)
if (plain !== null) window.history.replaceState(window.history.state, '', plain)
setClubFromPath(window.location.pathname)
// Adding another club's pages to the home screen makes that club's app
linkClubManifest()

setUpErrorReporting()
setUpApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={clubBase() || undefined}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
