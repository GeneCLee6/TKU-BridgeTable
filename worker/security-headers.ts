/**
 * Security headers (e11-t23, docs/SECURITY.md §2). Two places send them:
 *
 * - The pages and their files are static assets that never reach the Worker; `public/_headers`
 *   gives them `PAGE_HEADERS` (a test checks the file matches).
 * - The Worker's own answers (`/api/*`, `/ws`) get `API_HEADERS` in `withSecurityHeaders`.
 *
 * The page's Content-Security-Policy allows only what the site uses: its own scripts and the DDS
 * WebAssembly (`'wasm-unsafe-eval'`, compiled from bytes in a Web Worker), styled-components'
 * `<style>` tags and React's `style` attributes (`'unsafe-inline'` for styles only), pictures and
 * fonts from the site or `data:`/`blob:` (an avatar being cropped, a share card), and requests and
 * WebSockets to the site itself (`connect-src 'self'` covers `wss:` to the same host). Pictures of
 * posts and articles, avatars and e-book PDFs come from the Worker's own `/api/files/` and
 * `/api/avatar/`; TKU BridgeBook reaches `/api/book/*` through its own domain (Vercel), so neither
 * needs another origin here.
 */

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** What every answer carries */
const COMMON: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Two years, and the subdomains: the site is only ever served over HTTPS (browsers ignore it over http://localhost)
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
}

/** The pages and their files (`public/_headers`) */
export const PAGE_HEADERS: Record<string, string> = {
  ...COMMON,
  'Content-Security-Policy': PAGE_CSP,
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
}

/**
 * The API's answers: JSON, pictures and PDFs that are never a page to run. A file by its signed
 * address (`/api/files/…`) may be shown in another site's frame (BridgeHall's PDF reader), so it
 * keeps only the common headers
 */
export const API_HEADERS: Record<string, string> = {
  ...COMMON,
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
  'X-Frame-Options': 'DENY',
}

/** The Worker's answer with the security headers it lacks; a WebSocket upgrade (101) is left as it is */
export function withSecurityHeaders(response: Response, pathname: string): Response {
  if (response.status === 101) return response
  const headers = pathname.startsWith('/api/files/') ? COMMON : pathname.startsWith('/api/') || pathname.startsWith('/ws') ? API_HEADERS : PAGE_HEADERS
  let out = response
  try {
    for (const [key, value] of Object.entries(headers)) if (!out.headers.has(key)) out.headers.set(key, value)
  } catch {
    // Headers that cannot change (an answer passed straight through): copy it once
    out = new Response(response.body, response)
    for (const [key, value] of Object.entries(headers)) if (!out.headers.has(key)) out.headers.set(key, value)
  }
  return out
}

/** `public/_headers` as it should read: every path gets `PAGE_HEADERS` */
export function headersFile(): string {
  return ['/*', ...Object.entries(PAGE_HEADERS).map(([key, value]) => `  ${key}: ${value}`)].join('\n') + '\n'
}
