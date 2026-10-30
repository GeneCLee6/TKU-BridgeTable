import { CARD_PDF_LIMITS } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'
import { TokenBuckets } from './rate-limit.ts'

/**
 * TKU BridgeHall's convention card as a PDF (制度卡 PDF, E3 e3-t13, AC-3.4), made by Cloudflare's
 * Browser Run (formerly Browser Rendering) from the card page's own print layout: the page sends
 * its printable HTML (its styles inlined, no scripts) and this prints it to A4 in a headless
 * Chrome. Without the `BROWSER` binding, or when Browser Run fails or the day's budget is used, it
 * answers `cardPdfOff` (503) or `cardPdfBusy` (429) and the page falls back to the browser's own
 * print dialog, as before.
 *
 * The Workers Free plan gives 10 minutes of browser time a day (Browser Run's limits page), so:
 * each member may make `perMemberBurst` PDFs at once and then one every `perMemberEveryMs`; the
 * club stops at `dailyBrowserMs` of browser time a day (the `X-Browser-Ms-Used` of each answer),
 * leaving the rest of the 10 minutes alone; the same HTML within `cacheMs` is answered from memory
 * without asking the browser again. All of it is kept in memory, as the other rate limits are
 * (rate-limit.ts): an evicted object starts over, which only ever lets a little more through.
 *
 * The page renders with JavaScript off and every http(s) request blocked: what the PDF shows is the
 * HTML sent and the browser's own fonts (Arial, Noto CJK), so it can neither fetch nor run anything.
 */

/** The options this passes (a subset of workers-types' `BrowserRunPDFOptions`, which the tests cannot see) */
export interface PdfOptions {
  html: string
  setJavaScriptEnabled: boolean
  emulateMediaType: 'print'
  rejectRequestPattern: string[]
  gotoOptions: { waitUntil: 'load'; timeout: number }
  pdfOptions: { format: 'a4'; landscape: boolean; printBackground: boolean; preferCSSPageSize: boolean; timeout: number }
  cacheTTL: number
}

/** What the binding offers that this uses (`BrowserRun` in workers-types) */
export interface PdfBrowser {
  quickAction(action: 'pdf', options: PdfOptions): Promise<Response>
}

interface Cached {
  bytes: ArrayBuffer
  at: number
}

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

export class CardPdfService {
  private readonly browser: PdfBrowser | undefined
  private readonly now: () => number
  private readonly members: TokenBuckets
  private readonly cache = new Map<string, Cached>()
  private day = ''
  private usedMs = 0

  constructor(browser: PdfBrowser | undefined, now: () => number = Date.now) {
    this.browser = browser
    this.now = now
    this.members = new TokenBuckets(CARD_PDF_LIMITS.perMemberBurst, 1000 / CARD_PDF_LIMITS.perMemberEveryMs, now)
  }

  /** Whether the binding is there (the page still falls back when a PDF fails) */
  get ready(): boolean {
    return !!this.browser
  }

  /** The PDF of `body.html` on A4 in `body.paper`'s orientation */
  async render(userId: string, body: Record<string, unknown>): Promise<ArrayBuffer> {
    const { html, paper } = body
    if (typeof html !== 'string' || !html.trim()) fail('沒有制度卡內容')
    const text = html as string
    if (new TextEncoder().encode(text).length > CARD_PDF_LIMITS.htmlBytesMax) fail('制度卡太大')
    if (paper !== 'A4-landscape' && paper !== 'A4-portrait') fail('不認得的紙張')
    const browser = this.browser
    if (!browser) throw new ClubError('cardPdfOff', {}, 503)

    const key = `${paper}\n${await sha256(text)}`
    const now = this.now()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < CARD_PDF_LIMITS.cacheMs) return hit.bytes

    const today = new Date(now).toISOString().slice(0, 10)
    if (today !== this.day) {
      this.day = today
      this.usedMs = 0
    }
    if (this.usedMs >= CARD_PDF_LIMITS.dailyBrowserMs) throw new ClubError('cardPdfBusy', {}, 429)
    if (!this.members.take(userId)) throw new ClubError('cardPdfBusy', {}, 429)

    let response: Response
    try {
      response = await browser.quickAction('pdf', {
        html: text,
        setJavaScriptEnabled: false,
        emulateMediaType: 'print',
        rejectRequestPattern: ['^https?:'],
        gotoOptions: { waitUntil: 'load', timeout: 30_000 },
        pdfOptions: {
          format: 'a4',
          landscape: paper === 'A4-landscape',
          printBackground: true,
          // The card page's own @page rule (PrintStyle.tsx) sets the size and margins
          preferCSSPageSize: true,
          timeout: 30_000,
        },
        cacheTTL: 0,
      })
    } catch {
      throw new ClubError('cardPdfOff', {}, 503)
    }
    this.usedMs += Number(response.headers.get('X-Browser-Ms-Used')) || 0
    if (response.status === 429) throw new ClubError('cardPdfBusy', {}, 429)
    if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('application/pdf')) {
      throw new ClubError('cardPdfOff', {}, 503)
    }
    const bytes = await response.arrayBuffer()
    this.remember(key, { bytes, at: now })
    return bytes
  }

  private remember(key: string, entry: Cached) {
    this.cache.delete(key)
    this.cache.set(key, entry)
    while (this.cache.size > CARD_PDF_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value!)
  }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The answer: the PDF as a download */
export function pdfResponse(bytes: ArrayBuffer, name: string): Response {
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
}
