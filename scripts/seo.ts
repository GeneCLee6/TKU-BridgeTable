import { PUBLIC_PAGES, LANDING_PAGE, SHARE_IMAGE, SITE_URL, type PublicPage } from '../shared/site.ts'
import type { Strings } from '../src/strings.ts'

/**
 * What crawlers receive (e12-t14, DEPLOY.md §4.21). Pages are static assets that never reach the
 * Worker, so each public page is a file made when the site is built, costing no request any CPU:
 * `index.html` (which also answers every other path) says `noindex`, and each public page is that
 * same file with its own title, description, canonical link and share preview. The landing page
 * also carries its text, in English, for crawlers that run no script; React replaces it on load.
 */

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The tags of a page's `<head>` that say what it is */
function headTags(page: PublicPage, siteUrl: string, indexable: boolean): string {
  const url = `${siteUrl}${page.path}`
  const image = `${siteUrl}${SHARE_IMAGE.path}`
  const meta = (key: 'name' | 'property', name: string, content: string | number) => `<meta ${key}="${name}" content="${escape(String(content))}" />`
  return [
    `<meta name="description" content="${escape(page.description)}" />`,
    ...(indexable ? [] : ['<meta name="robots" content="noindex" />']),
    `<link rel="canonical" href="${url}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', 'Overtrick'),
    meta('property', 'og:title', page.title),
    meta('property', 'og:description', page.description),
    meta('property', 'og:url', url),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', SHARE_IMAGE.width),
    meta('property', 'og:image:height', SHARE_IMAGE.height),
    meta('property', 'og:image:alt', SHARE_IMAGE.alt),
    meta('property', 'og:locale', 'en_US'),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', page.title),
    meta('name', 'twitter:description', page.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', SHARE_IMAGE.alt),
  ].join('\n    ')
}

/** The landing page's words as plain HTML, inside `#root`, styled just enough to be read before the app takes over */
export function landingBody(l: Strings['landing']): string {
  const section = (title: string, body: string) => `<section><h2>${escape(title)}</h2>${body}</section>`
  const feature = (h: string, p: string) => `<h3>${escape(h)}</h3><p>${escape(p)}</p>`
  return [
    '<main style="max-width:720px;margin:0 auto;padding:32px 16px;font-family:system-ui,sans-serif;line-height:1.6">',
    `<h1>${escape(l.headline)}</h1>`,
    `<p>${escape(l.lead)}</p>`,
    section(
      l.featuresTitle,
      [
        feature(l.tablesH, l.tablesP),
        feature(l.robotsH, l.robotsP),
        feature(l.analysisH, l.analysisP),
        feature(l.recordsH, l.recordsP),
        feature(l.challengesH, l.challengesP),
        feature(l.matchesH, l.matchesP),
      ].join(''),
    ),
    section(l.joinTitle, `<ol>${l.joinSteps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol><p><a href="/clubs/apply">${escape(l.joinCta)}</a></p>`),
    section(l.freeTitle, `<p>${escape(l.freeP)}</p>`),
    section(l.whoTitle, `<p>${escape(l.whoP)}</p>`),
    '</main>',
  ].join('')
}

/** `index.html` made into a public page */
export function publicPageHtml(index: string, page: PublicPage, options: { siteUrl?: string; indexable: boolean; body?: string }): string {
  const replaced = (html: string, pattern: RegExp, by: string) => {
    if (!pattern.test(html)) throw new Error(`index.html has nothing matching ${pattern}`)
    return html.replace(pattern, () => by)
  }
  let html = index
  html = replaced(html, /<meta name="robots"[^>]*>\s*/, '')
  html = replaced(html, /<meta name="description"[^>]*>/, headTags(page, options.siteUrl ?? SITE_URL, options.indexable))
  html = replaced(html, /<title>[^<]*<\/title>/, `<title>${escape(page.title)}</title>`)
  if (options.body) html = replaced(html, /<div id="root"><\/div>/, `<div id="root">${options.body}</div>`)
  return html
}

/**
 * `robots.txt`. Private pages are not disallowed on purpose: a crawler has to fetch them to read
 * their `noindex`. A staging or preview build asks not to be crawled at all and names no sitemap
 */
export function robotsTxt(indexable: boolean, siteUrl = SITE_URL): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n'
  return `User-agent: *\nDisallow: /api/\n\nSitemap: ${siteUrl}/sitemap.xml\n`
}

export function sitemapXml(siteUrl = SITE_URL): string {
  const urls = PUBLIC_PAGES.map((page) => `  <url><loc>${siteUrl}${page.path}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/** The files a build adds beside index.html; `indexable` is false for staging and previews */
export function seoFiles(index: string, landing: Strings['landing'], indexable: boolean): Record<string, string> {
  const files: Record<string, string> = { 'robots.txt': robotsTxt(indexable) }
  if (indexable) files['sitemap.xml'] = sitemapXml()
  for (const page of PUBLIC_PAGES)
    files[page.file] = publicPageHtml(index, page, { indexable, body: page.path === LANDING_PAGE ? landingBody(landing) : undefined })
  return files
}
