/**
 * The platform's public face (e12-t13, e12-t14, AC-12.6): its name, its address and the pages a
 * search engine may list. `SITE_URL` is the one place the site's address is written for canonical
 * links, share pictures, `robots.txt` and `sitemap.xml`; when a domain is bought, change it here and
 * deploy (DEPLOY.md §4.21). Nothing here is a club's: 淡江 and every other club keep their addresses,
 * cookies and data whatever this says.
 */

/** Where the production site is served. Not a domain we do not own: see DEPLOY.md §4.21 */
export const SITE_URL = 'https://tku-bridge-table.genelee-pro.workers.dev'

/** The platform's name, in every language; a club's own name is separate */
export const PLATFORM_NAME = 'Overtrick'

/** The landing page. The root stays the 淡江 club's, so its members' address does not change */
export const LANDING_PAGE = '/about'

/** The share picture (`public/`), 1200×630 */
export const SHARE_IMAGE = { path: '/og-image.png', width: 1200, height: 630, alt: 'Overtrick: online bridge for clubs' }

export interface PublicPage {
  path: string
  /** The file made for it (scripts/seo.ts): Cloudflare's assets serve `/about` from `about.html` */
  file: string
  title: string
  description: string
}

const DESCRIPTION =
  'Online bridge for clubs: real-time four-player tables, robots that bid 2/1, SAYC and Precision, post-game analysis, records, challenges and team matches. Free to use.'

/**
 * The only pages search engines may list and link previews may show; everything else gets
 * index.html, which says `noindex` (scripts/seo.ts). In English: the titles and previews default
 * to it whatever the visitor's language (社長 2026-11-07)
 */
export const PUBLIC_PAGES: readonly PublicPage[] = [
  { path: LANDING_PAGE, file: 'about.html', title: 'Overtrick: online bridge for clubs', description: DESCRIPTION },
  {
    path: '/clubs/apply',
    file: 'clubs/apply.html',
    title: 'Apply for a club · Overtrick',
    description: 'Apply to open your bridge club on Overtrick: its own address, members, tables and records. Free to use.',
  },
  { path: '/privacy', file: 'privacy.html', title: 'Privacy policy · Overtrick', description: 'How Overtrick collects, uses and protects your personal data.' },
  { path: '/terms', file: 'terms.html', title: 'Terms of use · Overtrick', description: 'The terms for using Overtrick, online bridge for clubs.' },
]

/** The tab's title on a page of the app: a public page's own, else the platform's name */
export function pageTitle(pathname: string): string {
  return PUBLIC_PAGES.find((page) => page.path === pathname)?.title ?? PLATFORM_NAME
}
