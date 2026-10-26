// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { MESSAGE_MAX_CHARS, parseClientMessage } from '../../shared/message-guard.ts'
import type { ServerMessage } from '../../shared/protocol.ts'
import { parseClientError } from '../../worker/client-errors.ts'
import type { LogEntry } from '../../worker/log.ts'
import { ACTION_BURST, CHAT_BURST, CLIENT_ERROR_BURST, LOGIN_FAILURES_PER_NAME, LOGIN_WINDOW_MS } from '../../worker/rate-limit.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

class FakeConnections implements Connections {
  online = new Set<string>()
  inbox = new Map<string, ServerMessage[]>()
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.inbox.set(userId, [...(this.inbox.get(userId) ?? []), message])
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
  errors(userId: string) {
    return (this.inbox.get(userId) ?? []).flatMap((m) => (m.type === 'error' ? [m.code] : []))
  }
}

let store: MemoryStore
let connections: FakeConnections
let club: ClubService
let logs: LogEntry[]
let time: number

beforeEach(async () => {
  store = memoryStore()
  connections = new FakeConnections()
  logs = []
  time = 1_000_000
  club = new ClubService(store, connections, {
    maxUsers: 10,
    now: () => time,
    schedule: () => {},
    log: (entry) => logs.push(entry),
  })
  await club.load()
})

async function founder() {
  const result = await club.register('gene', 'secret1', '')
  if (!('user' in result)) throw new Error('the first account should sign in at once')
  connections.online.add(result.user.id)
  club.connected(result.user.id)
  return result.user.id
}

const send = (userId: string, message: unknown) => club.handleRaw(userId, JSON.stringify(message))

describe('message validation (e11-t10)', () => {
  it('reads only objects with a plain type and the right field types', () => {
    expect(parseClientMessage('x'.repeat(MESSAGE_MAX_CHARS + 1))).toEqual({ error: 'messageTooLarge' })
    expect(parseClientMessage('{not json')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('[1,2]')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('null')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":5}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"no spaces"}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"play","card":{"suit":"S"}}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"chat"}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"claim","tricks":"13"}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"createChallenge","invitees":"amy"}')).toEqual({ error: 'badMessage' })
    expect(parseClientMessage('{"type":"play","card":"SA"}')).toEqual({ message: { type: 'play', card: 'SA' } })
    expect(parseClientMessage('{"type":"stand"}')).toEqual({ message: { type: 'stand' } })
    // A type without a guard (a newer action) only gets the shape check; its handler decides
    expect(parseClientMessage('{"type":"someNewAction","x":1}')).toEqual({ message: { type: 'someNewAction', x: 1 } })
    expect(parseClientMessage('{"type":"toString"}')).toEqual({ message: { type: 'toString' } })
  })

  it('answers a message that is not valid with an error and never runs a handler', async () => {
    const gene = await founder()
    await club.handleRaw(gene, '{oops')
    await send(gene, { type: 'joinTable', tableId: 42 })
    await club.handleRaw(gene, JSON.stringify({ type: 'chat', text: 'x'.repeat(MESSAGE_MAX_CHARS) }))
    await send(gene, { type: 'warpDrive' })
    expect(connections.errors(gene)).toEqual(['badMessage', 'badMessage', 'messageTooLarge', 'unknownCommand'])
    expect(club.health().tables).toBe(0)
    await send(gene, { type: 'createTable' })
    expect(club.health().tables).toBe(1)
  })
})

describe('rate limits (e11-t11)', () => {
  it('lets a burst of actions through, then slows a member down until tokens come back', async () => {
    const gene = await founder()
    for (let i = 0; i < ACTION_BURST; i++) await send(gene, { type: 'stand' })
    expect(connections.errors(gene)).not.toContain('slowDown')
    await send(gene, { type: 'createTable' })
    expect(connections.errors(gene)).toEqual(['slowDown'])
    expect(club.health().tables).toBe(0)
    time += 1000
    await send(gene, { type: 'createTable' })
    expect(club.health().tables).toBe(1)
  })

  it('stops a chat flood but not the rest of the game', async () => {
    const gene = await founder()
    await send(gene, { type: 'createTable' })
    for (let i = 0; i < CHAT_BURST + 2; i++) await send(gene, { type: 'chat', text: `hi ${i}` })
    expect(connections.errors(gene)).toEqual(['chatTooFast', 'chatTooFast'])
    time += 2000
    await send(gene, { type: 'chat', text: 'later' })
    expect(connections.errors(gene)).toHaveLength(2)
  })

  it('locks a username from one address after repeated wrong passwords, for a while', async () => {
    await founder()
    for (let i = 0; i < LOGIN_FAILURES_PER_NAME; i++)
      await expect(club.login('gene', 'wrong', '1.2.3.4')).rejects.toMatchObject({ code: 'badLogin' })
    await expect(club.login('gene', 'secret1', '1.2.3.4')).rejects.toMatchObject({ code: 'tooManyLogins', status: 429 })
    // Another address is not locked out, so a stranger cannot lock a member out everywhere
    expect((await club.login('gene', 'secret1', '5.6.7.8')).user.username).toBe('gene')
    time += LOGIN_WINDOW_MS
    expect((await club.login('gene', 'secret1', '1.2.3.4')).user.username).toBe('gene')
    expect(logs.some((e) => e.event === 'loginLocked')).toBe(true)
  })

  it('a right password clears the count', async () => {
    await founder()
    for (let i = 0; i < LOGIN_FAILURES_PER_NAME - 1; i++) await club.login('gene', 'wrong', 'a').catch(() => {})
    await club.login('gene', 'secret1', 'a')
    await club.login('gene', 'wrong', 'a').catch(() => {})
    expect((await club.login('gene', 'secret1', 'a')).user.username).toBe('gene')
  })
})

describe('structured logs and health (e11-t08)', () => {
  it('logs every action with its type, time and error code, and rejected messages', async () => {
    const gene = await founder()
    await send(gene, { type: 'createTable' })
    await send(gene, { type: 'sit', tableId: 'nope', seat: 'N' })
    await club.handleRaw(gene, '{oops')
    expect(logs).toEqual([
      { event: 'action', type: 'createTable', user: gene, ms: 0 },
      { event: 'action', type: 'sit', user: gene, ms: 0, code: 'tableGone' },
      { event: 'rejected', user: gene, code: 'badMessage' },
    ])
  })

  it('logs a bug in a handler and answers serverError instead of dropping the socket', async () => {
    const gene = await founder()
    store.put = () => Promise.reject(new Error('disk on fire'))
    await send(gene, { type: 'createTable' })
    expect(connections.errors(gene)).toEqual(['serverError'])
    expect(logs.at(-1)).toMatchObject({ event: 'crash', where: 'createTable', error: 'disk on fire' })
  })

  it('reports health with counts only', async () => {
    const gene = await founder()
    await send(gene, { type: 'createTable' })
    expect(club.health()).toEqual({ ok: true, now: time, tables: 1, online: 1 })
  })

  it('adds the last hour’s numbers and alerts for the status page (e11-t22)', async () => {
    const gene = await founder()
    await send(gene, { type: 'createTable' })
    await send(gene, { type: 'addRobot', seat: 'N' })
    await send(gene, { type: 'sit', tableId: 'nope', seat: 'N' })
    club.logEntry({ event: 'http', method: 'GET', path: '/api/health', status: 200, ms: 0 })
    const status = club.status()
    expect(status).toMatchObject({ ok: true, tables: 1, online: 1, playing: 1, robots: 1, alerts: [] })
    expect(status.metrics).toMatchObject({ actions: 3, refused: 1, crashes: 0, requests: 1, connects: 1, reconnects: 0, peakOnline: 1 })
    expect(JSON.stringify(status)).not.toContain(gene)
    expect(logs.at(-1)).toMatchObject({ event: 'http', path: '/api/health' })
  })
})

describe('browser error reports (e11-t09)', () => {
  it('keeps only known fields and masks personal data', () => {
    const entry = parseClientError(
      JSON.stringify({
        kind: 'rejection',
        message: 'TypeError: amy@example.com failed at https://tku.example/table/abc?token=secret#x',
        stack: 'at f (https://tku.example/assets/app.js?v=1234567:1:2)',
        page: '/table/abc',
        version: 'abc123',
        userId: 'u1',
        cookie: 'tbt_session=secret',
      }),
    )
    expect(entry).toEqual({
      event: 'clientError',
      kind: 'rejection',
      message: 'TypeError: <email> failed at https://tku.example/table/abc',
      stack: 'at f (https://tku.example/assets/app.js)',
      page: '/table/abc',
      version: 'abc123',
    })
    expect(parseClientError('{}')).toBeNull()
    expect(parseClientError('nope')).toBeNull()
    expect(parseClientError(JSON.stringify({ message: 'x'.repeat(9000) }))).toBeNull()
  })

  it('logs a few reports a second at most', () => {
    const report = JSON.stringify({ kind: 'error', message: 'boom' })
    for (let i = 0; i < CLIENT_ERROR_BURST + 5; i++) expect(club.reportClientError(report)).toBe(true)
    expect(logs.filter((e) => e.event === 'clientError')).toHaveLength(CLIENT_ERROR_BURST)
    expect(club.reportClientError('{"kind":"error"}')).toBe(false)
  })
})
