// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { landingBody, publicPageHtml, robotsTxt, seoFiles, sitemapXml } from '../../scripts/seo.ts'
import { LANDING_PAGE, pageTitle, PUBLIC_PAGES, SHARE_IMAGE, SITE_URL } from '../../shared/site.ts'
import { STRINGS } from '../../src/strings.ts'
import { headersFile } from '../../worker/security-headers.ts'

/** What crawlers receive (e12-t14, scripts/seo.ts); the logo's rule is DESIGN.md §6 */

const index = readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')
const landing = STRINGS.en.landing
const CJK = /[぀-ヿ㐀-鿿가-힣]/

describe('private pages', () => {
  it('the shell every other path gets says noindex and offers nothing to preview', () => {
    expect(index).toContain('<meta name="robots" content="noindex" />')
    expect(index).not.toContain('og:')
    expect(index).not.toContain('rel="canonical"')
    expect(index).not.toMatch(CJK)
    expect(index).toContain('<title>Overtrick</title>')
  })

  it('a shared board says noindex in a header too, at any club’s address', () => {
    expect(headersFile()).toMatch(/\/share\/\*\n {2}X-Robots-Tag: noindex/)
    expect(headersFile()).toMatch(/\/c\/:club\/share\/\*\n {2}X-Robots-Tag: noindex/)
  })

  it('robots.txt does not hide them: a crawler has to fetch a page to read its noindex', () => {
    const robots = robotsTxt(true)
    expect(robots).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`)
    for (const path of ['/share/', '/table/', '/history/', '/c/']) expect(robots).not.toContain(`Disallow: ${path}`)
  })

  it('the sitemap lists the public pages and nothing else', () => {
    const urls = [...sitemapXml().matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(urls).toEqual(PUBLIC_PAGES.map((page) => `${SITE_URL}${page.path}`))
    expect(urls).not.toContain(`${SITE_URL}/`)
  })
})

describe('public pages', () => {
  const about = PUBLIC_PAGES.find((page) => page.path === LANDING_PAGE)!

  it.each(PUBLIC_PAGES.map((page) => [page.path, page] as const))('%s has its own head, in English', (_path, page) => {
    const html = publicPageHtml(index, page, { indexable: true })
    expect(html).not.toContain('noindex')
    expect(html).toContain(`<title>${page.title.replace(/&/g, '&amp;')}</title>`)
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}${page.path}" />`)
    expect(html).toContain(`<meta property="og:url" content="${SITE_URL}${page.path}" />`)
    expect(html).toContain(`<meta property="og:image" content="${SITE_URL}${SHARE_IMAGE.path}" />`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html.match(/<meta name="description"/g)).toHaveLength(1)
    expect(html).not.toMatch(CJK)
    expect(page.description.length).toBeLessThanOrEqual(170)
  })

  it('every address comes from the one setting', () => {
    const other = 'https://example.org'
    const html = publicPageHtml(index, about, { indexable: true, siteUrl: other })
    expect(html).toContain(`<link rel="canonical" href="${other}/about" />`)
    expect(html).not.toContain(SITE_URL)
    expect(robotsTxt(true, other)).toContain(`Sitemap: ${other}/sitemap.xml`)
    expect(sitemapXml(other)).not.toContain(SITE_URL)
  })

  it('the landing page carries its words for crawlers that run no script', () => {
    const files = seoFiles(index, landing, true)
    const html = files['about.html']
    for (const text of [landing.headline, landing.tablesH, landing.matchesH, landing.freeP]) expect(html).toContain(text)
    expect(html).toContain('<div id="root"><main')
    expect(html).not.toMatch(CJK)
    expect(landingBody(landing)).not.toMatch(/<script/)
    // The other public pages are the app's own, with no words of their own to go stale
    expect(files['privacy.html']).toContain('<div id="root"></div>')
  })

  it('a build for staging or a preview asks to be left alone', () => {
    const files = seoFiles(index, landing, false)
    expect(files['robots.txt']).toBe('User-agent: *\nDisallow: /\n')
    expect(files['sitemap.xml']).toBeUndefined()
    for (const page of PUBLIC_PAGES) expect(files[page.file]).toContain('noindex')
  })

  it('the tab says each public page’s title, and the platform’s name elsewhere', () => {
    expect(pageTitle('/about')).toBe(about.title)
    expect(pageTitle('/')).toBe('Overtrick')
    expect(pageTitle('/table/t1')).toBe('Overtrick')
  })
})

describe('the brand’s files', () => {
  it.each(['public/logo.svg', 'public/logo-mark.svg', 'public/favicon.svg', 'public/manifest.webmanifest'])('%s is in English only', (file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('Overtrick')
    expect(text).not.toMatch(CJK)
    expect(text).not.toContain('BridgeTable')
  })

  it('the logo files read in the dark as well', () => {
    for (const file of ['public/logo.svg', 'public/logo-mark.svg']) expect(readFileSync(file, 'utf8')).toContain('prefers-color-scheme:dark')
  })

  it('the club’s own logo is still there', () => {
    expect(readFileSync('public/brand/tamkang-mark.svg', 'utf8')).toContain('淡江牌桌')
  })

  it('the share picture is a 1200×630 PNG, small enough for link previews', () => {
    const png = readFileSync('public/og-image.png')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([SHARE_IMAGE.width, SHARE_IMAGE.height])
    expect(png.length).toBeLessThan(300_000)
  })
})
