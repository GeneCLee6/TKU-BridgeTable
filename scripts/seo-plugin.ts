import type { Plugin } from 'vite'
import { STRINGS } from '../src/strings.ts'
import { seoFiles } from './seo.ts'

/**
 * Adds the public pages, `robots.txt` and `sitemap.xml` to the browser's build (scripts/seo.ts).
 * A build for staging or a pull request's preview names its environment in `CLOUDFLARE_ENV`
 * (DEPLOY.md §2.1): those tell crawlers to stay away, so only production can be listed.
 */
export const seoPages = (): Plugin => ({
  name: 'seo-pages',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const index = bundle['index.html']
    if (this.environment.name !== 'client' || index?.type !== 'asset') return
    const files = seoFiles(String(index.source), STRINGS.en.landing, !process.env.CLOUDFLARE_ENV)
    for (const [fileName, source] of Object.entries(files)) this.emitFile({ type: 'asset', fileName, source })
  },
})
