/**
 * npm run seed -- --url <staging or preview site> [--members 8] [--admin admin]
 * The password and invite code come from SEED_PASSWORD and SEED_INVITE_CODE (kept out of the shell
 * history and the Actions log). DEPLOY.md §2.1.
 */
import { parseArgs } from 'node:util'
import { seed } from './seed.ts'

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    members: { type: 'string', default: '8' },
    admin: { type: 'string', default: 'admin' },
  },
})

const password = process.env.SEED_PASSWORD ?? ''
if (!values.url || !password) {
  console.error('Usage: SEED_PASSWORD=... [SEED_INVITE_CODE=...] npm run seed -- --url <site> [--members 8] [--admin admin]')
  process.exit(2)
}

try {
  const result = await seed({
    url: values.url,
    password,
    inviteCode: process.env.SEED_INVITE_CODE ?? '',
    members: Number(values.members),
    admin: values.admin,
  })
  console.log(`Created: ${result.created.join(', ') || '(none)'}`)
  console.log(`Already there: ${result.existing.join(', ') || '(none)'}`)
  console.log(`Waiting for approval: ${result.pending.join(', ') || '(none)'}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
