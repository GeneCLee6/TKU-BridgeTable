import { scrub } from '../../shared/scrub.ts'
import { clubHeaders, withClub } from './club.ts'

/**
 * Sends the page's uncaught errors and unhandled promise rejections to `/api/client-errors`
 * (AC-11.5), where they land in the Worker's logs. Nothing that identifies the member goes along:
 * no user id, no query strings or fragments, e-mail addresses and long numbers are masked. Only a
 * sample is sent, the same error once, and a few per page at most
 */

export const REPORT_URL = '/api/client-errors'
/** Share of errors reported; the club is small, so all of them for now */
export const REPORT_SAMPLE_RATE = 1
/** Reports per page load at most, so a render loop that keeps failing sends a handful, not thousands */
export const REPORT_MAX_PER_PAGE = 5

export interface ClientErrorReport {
  kind: 'error' | 'rejection'
  message: string
  source?: string
  stack?: string
  page: string
  version: string
}

/** The report for an error or a rejection reason; null when there is nothing worth sending */
export function buildReport(
  kind: ClientErrorReport['kind'],
  error: unknown,
  page: string,
  version: string,
  source?: string,
): ClientErrorReport | null {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : ''
  if (!message) return null
  const report: ClientErrorReport = { kind, message: scrub(message, 500), page: scrub(page, 200), version: version.slice(0, 40) }
  if (error instanceof Error && error.stack) report.stack = scrub(error.stack, 2000)
  if (source) report.source = scrub(source, 200)
  return report
}

/** The version the page was built from (`<meta name="app-version">`) */
export const appVersion = () => document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content ?? 'unknown'

/** What this page load has sent: uncaught errors and those an error boundary caught share the limits */
let seen = new Set<string>()

function send(report: ClientErrorReport | null) {
  if (!report || seen.size >= REPORT_MAX_PER_PAGE || seen.has(report.message)) return
  seen.add(report.message)
  if (Math.random() >= REPORT_SAMPLE_RATE) return
  const body = JSON.stringify(report)
  try {
    // A beacon carries no header: another club's names itself in the address (e12-t04)
    if (navigator.sendBeacon?.(withClub(REPORT_URL), body)) return
    void fetch(REPORT_URL, { method: 'POST', body, keepalive: true, headers: clubHeaders({ 'Content-Type': 'application/json' }) }).catch(() => {})
  } catch {
    // Reporting must never cause another error
  }
}

/**
 * An error an error boundary caught (components/ErrorBoundary.tsx): React logs those to the console
 * and fires no `error` event, so the listeners below never see them. `where` names the boundary
 */
export function reportCaughtError(error: unknown, where: string) {
  try {
    // `throw null` or an object still happened: a report with its text beats none
    const reason = error instanceof Error || typeof error === 'string' ? error : String(error)
    send(buildReport('error', reason, location.pathname, appVersion(), where))
  } catch {
    // Reporting must never cause another error
  }
}

/** Call once at start-up */
export function setUpErrorReporting() {
  if (typeof window === 'undefined') return
  seen = new Set()
  const version = appVersion()
  window.addEventListener('error', (event) => {
    // Failed images and scripts fire `error` too, without an error object; those are not bugs in the page
    if (!event.error && !event.message) return
    const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    send(buildReport('error', event.error ?? event.message, location.pathname, version, source))
  })
  window.addEventListener('unhandledrejection', (event) => {
    send(buildReport('rejection', event.reason, location.pathname, version))
  })
}
