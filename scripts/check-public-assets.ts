import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { clubOnlyRows, cardRows, rowsIn } from '../shared/robot/system/card-leaks.ts'
import { deriveCard } from '../shared/robot/system/card.ts'
import { OPEN_SYSTEMS } from '../shared/robot/system/open-systems.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'

/**
 * Part of `npm run build`: the club's system card must not be in anything the site serves publicly
 * (`dist/client`, ARCHITECTURE.md §4), since a published file cannot be taken back. It also checks it
 * can see at all: every public system's card has to be found in the assets and the club's in the Worker.
 */

const textFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return textFiles(path)
    return /\.(js|mjs|css|html|json|map|txt|webmanifest)$/.test(name) || name === '_headers' ? [readFileSync(path, 'utf8')] : []
  })

const open = Object.values(OPEN_SYSTEMS).map(deriveCard)
const club = deriveCard(TKU)
const clubRows = clubOnlyRows(club, open)
const assets = textFiles('dist/client')
const workers = readdirSync('dist')
  .filter((name) => name !== 'client' && statSync(join('dist', name)).isDirectory())
  .flatMap((name) => textFiles(join('dist', name)))

const fail = (message: string) => {
  console.error(`check-public-assets: ${message}`)
  process.exit(1)
}

const leaked = rowsIn(clubRows, assets)
if (leaked.length) fail(`${leaked.length} rows of the club's system card are in dist/client, for example ${leaked[0]}`)
if (clubRows.length < 100) fail(`only ${clubRows.length} rows to look for: the check would prove little`)
for (const card of open)
  if (rowsIn(cardRows(card), assets).length !== cardRows(card).length) fail(`cannot find the ${card.system} card in dist/client: the check no longer sees built text`)
if (rowsIn(clubRows, workers).length !== clubRows.length) fail("cannot find the club's card in the Worker")
console.log(`check-public-assets: none of ${clubRows.length} rows of the club's card in ${assets.length} public files`)
