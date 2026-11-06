import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { reportCaughtError } from '../lib/errorReport.ts'
import { storedLang, usePreferences } from '../state/PreferencesContext.tsx'
import { STRINGS } from '../strings.ts'
import { createTheme, fonts } from '../styles/tokens.ts'
import { Button, Muted, PageMain, PageTitle } from './ui.tsx'

/**
 * A render error must not blank the app (ARCHITECTURE.md §5.6). React unmounts everything under the
 * nearest boundary, so what is under each one is what a failure may take with it:
 *
 * - `RootBoundary` (main.tsx), around everything: the last resort, when the providers themselves
 *   fail. No theme, router or preferences are left, so it needs none of them.
 * - `PageBoundary`, around the routed page: the header stays, with a message and a retry. Going to
 *   another page clears it.
 * - `PartBoundary`, around what is always on screen besides the page (banners, the bell, the dock,
 *   the table's dialogs): by default that part just goes.
 *
 * Every boundary reports what it caught through the client-error path (`reportCaughtError`), which
 * nothing else would do: React sends a caught error only to the console.
 */

interface BoundaryProps {
  /** In the report's `source`, as `boundary:<name>`: which boundary caught it */
  name: string
  /** A new value clears a failure: what failed may work now */
  resetKey?: unknown
  fallback: (retry: () => void) => ReactNode
  onFail?: () => void
  children: ReactNode
}

class ErrorBoundary extends Component<BoundaryProps, { failed: boolean; resetKey: unknown }> {
  override state = { failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromProps({ resetKey }: BoundaryProps, state: { resetKey: unknown }) {
    return resetKey === state.resetKey ? null : { failed: false, resetKey }
  }

  // A flag and not the error: `throw null` is an error too
  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    reportCaughtError(error, `boundary:${this.props.name}`)
    this.props.onFail?.()
  }

  private readonly retry = () => this.setState({ failed: false })

  override render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children
  }
}

function PageFailed({ retry }: { retry: () => void }) {
  const { t } = usePreferences()
  return (
    <PageMain>
      <div role="alert">
        <PageTitle>{t.errorBoundary.title}</PageTitle>
        <Muted>{t.errorBoundary.hint}</Muted>
      </div>
      <p>
        <Button type="button" $variant="primary" onClick={retry}>
          {t.errorBoundary.retry}
        </Button>
      </p>
      <p>
        <Link to="/">{t.errorBoundary.home}</Link>
      </p>
    </PageMain>
  )
}

/** The routed page: the rest of the app stays; a retry mounts the page anew, and so does another address */
export function PageBoundary({ name, children }: { name: string; children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <ErrorBoundary name={name} resetKey={pathname} fallback={(retry) => <PageFailed retry={retry} />}>
      {children}
    </ErrorBoundary>
  )
}

/** Says a part cannot be shown, where its empty place would look like nothing is there */
export function PartFailedNote() {
  const { t } = usePreferences()
  return <Muted role="status">{t.errorBoundary.part}</Muted>
}

/** Something beside the page: when it fails only it goes (or `fallback` takes its place) */
export function PartBoundary({
  name,
  resetKey,
  fallback = null,
  onFail,
  children,
}: {
  name: string
  resetKey?: unknown
  fallback?: ReactNode
  onFail?: () => void
  children: ReactNode
}) {
  return (
    <ErrorBoundary name={name} resetKey={resetKey} fallback={() => fallback} onFail={onFail}>
      {children}
    </ErrorBoundary>
  )
}

/** Whatever is left when nothing of the app is: words in the member's language, reload and home */
function RootFailed() {
  const t = STRINGS[storedLang()].errorBoundary
  const { colors, radius } = createTheme('light', 'two')
  return (
    <main role="alert" style={{ maxWidth: 560, margin: '48px auto', padding: 16, color: colors.text, fontFamily: fonts.body }}>
      <h1 style={{ fontSize: 22, color: colors.primaryStrong }}>{t.title}</h1>
      <p>{t.hint}</p>
      <p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ padding: '8px 16px', border: 0, borderRadius: radius.sm, background: colors.primary, color: colors.onPrimary, cursor: 'pointer' }}
        >
          {t.reload}
        </button>
      </p>
      <p>
        <a href="/" style={{ color: colors.primary }}>
          {t.home}
        </a>
      </p>
    </main>
  )
}

export function RootBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary name="root" fallback={() => <RootFailed />}>
      {children}
    </ErrorBoundary>
  )
}
