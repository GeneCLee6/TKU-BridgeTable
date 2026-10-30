// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CARD_PDF_LIMITS } from '../../shared/protocol.ts'
import { CardPdfService, type PdfBrowser, type PdfOptions } from '../../worker/card-pdf.ts'
import { ClubError } from '../../worker/errors.ts'
import { bookRouteNeed } from '../../worker/roles.ts'

const PDF = new Uint8Array([37, 80, 68, 70, 45])
const html = '<!doctype html><html lang="zh-Hant"><body><div data-card-paper>1NT 15-17</div></body></html>'

let time: number
let calls: PdfOptions[]
let answer: () => Response

const browser: PdfBrowser = {
  async quickAction(_action, options) {
    calls.push(options)
    return answer()
  },
}

const pdfAnswer = (ms = 2_000) =>
  new Response(PDF, { headers: { 'Content-Type': 'application/pdf', 'X-Browser-Ms-Used': String(ms) } })

async function code(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error instanceof ClubError ? `${error.code} ${error.status}` : String(error)
  }
  return 'ok'
}

beforeEach(() => {
  time = Date.UTC(2026, 9, 30, 4)
  calls = []
  answer = () => pdfAnswer()
})

describe('card PDFs (BridgeHall e3-t13)', () => {
  it('prints the HTML with scripts off and every request blocked, on A4 in the form’s orientation', async () => {
    const pdf = new CardPdfService(browser, () => time)
    expect(new Uint8Array(await pdf.render('u1', { html, paper: 'A4-landscape' }))).toEqual(PDF)
    const [options] = calls
    expect(options).toMatchObject({
      html,
      setJavaScriptEnabled: false,
      emulateMediaType: 'print',
      rejectRequestPattern: ['^https?:'],
      pdfOptions: { format: 'a4', landscape: true, printBackground: true, preferCSSPageSize: true },
    })
    await pdf.render('u1', { html: `${html} `, paper: 'A4-portrait' })
    expect(calls[1]!.pdfOptions.landscape).toBe(false)
  })

  it('refuses what is not a card', async () => {
    const pdf = new CardPdfService(browser, () => time)
    expect(await code(pdf.render('u1', { paper: 'A4-landscape' }))).toBe('badContent 400')
    expect(await code(pdf.render('u1', { html, paper: 'letter' }))).toBe('badContent 400')
    expect(await code(pdf.render('u1', { html: 'x'.repeat(CARD_PDF_LIMITS.htmlBytesMax + 1), paper: 'A4-portrait' }))).toBe('badContent 400')
    expect(calls).toHaveLength(0)
  })

  it('answers cardPdfOff without the binding or when Browser Run fails, so the page prints instead', async () => {
    expect(await code(new CardPdfService(undefined, () => time).render('u1', { html, paper: 'A4-landscape' }))).toBe('cardPdfOff 503')
    const pdf = new CardPdfService(browser, () => time)
    answer = () => Response.json({ success: false }, { status: 500 })
    expect(await code(pdf.render('u1', { html, paper: 'A4-landscape' }))).toBe('cardPdfOff 503')
    answer = () => {
      throw new Error('no browser')
    }
    expect(await code(pdf.render('u1', { html: `${html}1`, paper: 'A4-landscape' }))).toBe('cardPdfOff 503')
    answer = () => Response.json({ success: false }, { status: 429 })
    expect(await code(pdf.render('u1', { html: `${html}2`, paper: 'A4-landscape' }))).toBe('cardPdfBusy 429')
  })

  it('answers the same card again from memory, without the browser or the member’s allowance', async () => {
    const pdf = new CardPdfService(browser, () => time)
    for (let i = 0; i < CARD_PDF_LIMITS.perMemberBurst + 3; i++) await pdf.render('u1', { html, paper: 'A4-landscape' })
    expect(calls).toHaveLength(1)
    time += CARD_PDF_LIMITS.cacheMs
    await pdf.render('u1', { html, paper: 'A4-landscape' })
    expect(calls).toHaveLength(2)
  })

  it('limits each member, then lets one more through every few minutes', async () => {
    const pdf = new CardPdfService(browser, () => time)
    for (let i = 0; i < CARD_PDF_LIMITS.perMemberBurst; i++) await pdf.render('u1', { html: `${html}${i}`, paper: 'A4-landscape' })
    expect(await code(pdf.render('u1', { html: `${html}x`, paper: 'A4-landscape' }))).toBe('cardPdfBusy 429')
    expect(await code(pdf.render('u2', { html: `${html}x`, paper: 'A4-landscape' }))).toBe('ok')
    time += CARD_PDF_LIMITS.perMemberEveryMs
    expect(await code(pdf.render('u1', { html: `${html}y`, paper: 'A4-landscape' }))).toBe('ok')
  })

  it('stops for the day once the club has used its browser time, and starts again the next day', async () => {
    const pdf = new CardPdfService(browser, () => time)
    answer = () => pdfAnswer(CARD_PDF_LIMITS.dailyBrowserMs)
    await pdf.render('u1', { html, paper: 'A4-landscape' })
    expect(await code(pdf.render('u2', { html: `${html}x`, paper: 'A4-landscape' }))).toBe('cardPdfBusy 429')
    time += 24 * 60 * 60_000
    expect(await code(pdf.render('u2', { html: `${html}x`, paper: 'A4-landscape' }))).toBe('ok')
  })

  it('is any member’s, by POST only', () => {
    expect(bookRouteNeed('POST', '/card-pdf')).toBe('member')
    expect(bookRouteNeed('GET', '/card-pdf')).toBeNull()
  })
})
