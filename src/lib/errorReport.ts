import { scrub } from '../../shared/scrub.ts'

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

/** Call once at start-up */
export function setUpErrorReporting() {
  if (typeof window === 'undefined') return
  const seen = new Set<string>()
  const version = document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content ?? 'unknown'
  const send = (report: ClientErrorReport | null) => {
    if (!report || seen.size >= REPORT_MAX_PER_PAGE || seen.has(report.message)) return
    seen.add(report.message)
    if (Math.random() >= REPORT_SAMPLE_RATE) return
    const body = JSON.stringify(report)
    try {
      if (navigator.sendBeacon?.(REPORT_URL, body)) return
      void fetch(REPORT_URL, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {})
    } catch {
      // Reporting must never cause another error
    }
  }
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
