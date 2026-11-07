import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { MARK_CARDS, MARK_GOLD_CARD, MARK_RADIUS, WORD_HEIGHT, WORD_PATHS, WORD_STROKE, WORD_WIDTH } from '../src/components/overtrickArt.ts'

/**
 * Makes the Overtrick logo files, app icons and share picture in `public/` (DESIGN.md §6), once:
 * they are committed, nothing here runs in the build. Run it after changing the shapes:
 *
 *   node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/brand-assets.ts [outDir]
 *
 * SVG files cannot read `styles/tokens.ts`, so they carry the values of `header`, `onHeader` and
 * `accent` (light and dark) as literals.
 */

const NAVY = '#16243f'
const OFF_WHITE = '#f3efe6'
const GOLD = '#c9972e'
const GOLD_DARK = '#e0b255'

type Box = { x: number; y: number; width: number; height: number }
const rect = (c: Box, attrs: string) => `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="${MARK_RADIUS}" ${attrs}/>`

/** The mark's shapes, on a 64×64 canvas */
const markShapes = (ring: string, gold: string) => `${MARK_CARDS.map((c) => rect(c, ring)).join('')}${rect(MARK_GOLD_CARD, gold)}`

const word = (attrs: string) =>
  `<g fill="none" stroke-width="${WORD_STROKE}" stroke-linecap="round" stroke-linejoin="round" ${attrs}>${WORD_PATHS.map((d) => `<path d="${d}"/>`).join('')}</g>`

/** Light or dark page: the colours follow the viewer's setting */
const THEMED = `<style>.ink{fill:${NAVY}}.word{stroke:${NAVY}}.gold{fill:${GOLD}}@media (prefers-color-scheme:dark){.ink{fill:${OFF_WHITE}}.word{stroke:${OFF_WHITE}}.gold{fill:${GOLD_DARK}}}</style>`

const logoMark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Overtrick">${THEMED}${markShapes('class="ink"', 'class="gold"')}</svg>\n`

const LOGO_WIDTH = 78 + WORD_WIDTH + 4
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_WIDTH} 64" role="img" aria-label="Overtrick">${THEMED}${markShapes('class="ink"', 'class="gold"')}<g transform="translate(78 ${(64 - WORD_HEIGHT) / 2})">${word('class="word"')}</g></svg>\n`

/** A navy tile with the mark inset: reads on a browser tab of either colour, and at 16 px */
const tile = (radius: number, inset: number, title = '') => {
  const scale = (64 - inset * 2) / 64
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${title && `<title>${title}</title>`}<rect width="64" height="64" rx="${radius}" fill="${NAVY}"/><g transform="translate(${inset} ${inset}) scale(${scale})">${markShapes(`fill="${OFF_WHITE}"`, `fill="${GOLD_DARK}"`)}</g></svg>\n`
}

const share = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="${NAVY}"/>
<rect y="618" width="1200" height="12" fill="${GOLD_DARK}"/>
<g transform="translate(96 150) scale(3.6)">${markShapes(`fill="${OFF_WHITE}"`, `fill="${GOLD_DARK}"`)}</g>
<g transform="translate(372 190) scale(2.72)">${word(`stroke="${OFF_WHITE}"`)}</g>
<text x="380" y="400" font-family="Segoe UI, Arial, sans-serif" font-size="46" font-weight="600" fill="${OFF_WHITE}">Online bridge for clubs</text>
<text x="380" y="458" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#aab4c8">Live tables, robots, analysis, team matches</text>
</svg>`

const out = process.argv[2] ?? 'public'
mkdirSync(out, { recursive: true })
writeFileSync(`${out}/logo-mark.svg`, logoMark)
writeFileSync(`${out}/logo.svg`, logo)
writeFileSync(`${out}/favicon.svg`, tile(14, 5, 'Overtrick'))

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined })
async function png(file: string, svg: string, width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.setContent(`<!doctype html><style>*{margin:0}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`)
  await page.screenshot({ path: `${out}/${file}`, type: 'png' })
  await page.close()
}
await png('icon-192.png', tile(0, 8), 192, 192)
await png('icon-512.png', tile(0, 8), 512, 512)
await png('apple-touch-icon.png', tile(0, 8), 180, 180)
// Android masks the outer edge away: the mark stays inside the middle 80 %
await png('icon-maskable-512.png', tile(0, 13), 512, 512)
await png('og-image.png', share, 1200, 630)
await browser.close()
