import '@fontsource-variable/noto-sans-tc'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.tsx'
import { setUpErrorReporting } from './lib/errorReport.ts'
import { setUpApp } from './lib/pwa.ts'

setUpErrorReporting()
setUpApp()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
