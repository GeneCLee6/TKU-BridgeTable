/**
 * Makes worker/common-passwords.ts (e11-t29, docs/SECURITY.md V2.1.7) from SecLists'
 * `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (MIT License, Daniel Miessler;
 * the NCSC's top 100,000 of Have I Been Pwned's breached passwords). Only passwords the length
 * rules let through are kept (12–128 characters), lower-cased, without repeats.
 *
 *   node --experimental-strip-types scripts/common-passwords.ts <list.txt>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { LIMITS } from '../shared/protocol.ts'

const source = process.argv[2]
if (!source) {
  console.error('usage: scripts/common-passwords.ts <100k-most-used-passwords-NCSC.txt>')
  process.exit(1)
}
const kept = new Set<string>()
for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
  const password = line.toLowerCase()
  const length = [...password].length
  if (length >= LIMITS.passwordMin && length <= LIMITS.passwordMax) kept.add(password)
}
const out = `/**
 * Breached passwords long enough to pass the length rules (e11-t29, docs/SECURITY.md V2.1.7):
 * ${kept.size} of the NCSC's 100,000 most used passwords from Have I Been Pwned, lower-cased.
 * Source: SecLists (https://github.com/danielmiessler/SecLists), MIT License, Copyright (c) 2018
 * Daniel Miessler, Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt.
 * Made by scripts/common-passwords.ts; do not edit by hand.
 */
export const COMMON_PASSWORDS = ${JSON.stringify([...kept].join('\n'))}
`
writeFileSync(new URL('../worker/common-passwords.ts', import.meta.url), out)
console.log(`${kept.size} passwords`)
