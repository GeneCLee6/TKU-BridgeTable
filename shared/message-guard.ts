import type { MessageCode } from './messages.ts'
import type { ClientMessage } from './protocol.ts'

/**
 * The largest WebSocket message the server reads (characters). The biggest real one is a chat line
 * or a challenge with 20 invitees, well under 1 KiB
 */
export const MESSAGE_MAX_CHARS = 8192

type Fields = Record<string, unknown>
type Guard = (m: Fields) => boolean

const str = (v: unknown) => typeof v === 'string'
const bool = (v: unknown) => typeof v === 'boolean'
const obj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)
const opt = (check: (v: unknown) => boolean) => (v: unknown) => v === undefined || check(v)
const strings = (v: unknown) => Array.isArray(v) && v.every(str)

/**
 * Field types of the messages we know. A type that is not listed only gets the shape check, so a
 * new action works before it has a guard; the handler still checks values (seats, ranges, rights)
 */
const GUARDS: Partial<Record<ClientMessage['type'], Guard>> = {
  createTable: (m) => opt(obj)(m.settings) && opt(strings)(m.invitees),
  updateTableSettings: (m) => obj(m.settings) && opt(strings)(m.invitees),
  requestJoin: (m) => str(m.tableId),
  answerRequest: (m) => str(m.userId) && bool(m.accept),
  quickSeat: () => true,
  joinTable: (m) => str(m.tableId),
  sit: (m) => str(m.tableId) && str(m.seat),
  kick: (m) => str(m.seat),
  addRobot: (m) => str(m.seat) && opt(str)(m.kind),
  removeRobot: (m) => str(m.seat),
  replaceWithRobot: (m) => str(m.seat) && opt(str)(m.kind),
  call: (m) => str(m.call) && opt(str)(m.alert) && opt(str)(m.seat),
  play: (m) => str(m.card),
  claim: (m) => Number.isInteger(m.tricks),
  claimRespond: (m) => bool(m.accept),
  undoRespond: (m) => bool(m.accept),
  chat: (m) => str(m.text),
  createPractice: (m) => obj(m.settings) && opt(str)(m.access),
  redeal: () => true,
  rebid: () => true,
  readNotifications: (m) => opt(strings)(m.ids),
  setFriend: (m) => str(m.userId) && bool(m.friend),
  setBlocked: (m) => str(m.userId) && bool(m.blocked),
  playChallenge: (m) => str(m.challengeId),
  createChallenge: (m) =>
    strings(m.invitees) && opt((v) => typeof v === 'number')(m.boards) && opt(obj)(m.settings) && opt(strings)(m.fromBoards),
  answerChallenge: (m) => str(m.challengeId) && bool(m.accept),
  cancelChallenge: (m) => str(m.challengeId),
  rematchChallenge: (m) => str(m.challengeId),
  matchInvite: (m) => str(m.matchId) && str(m.room) && str(m.seat) && str(m.userId),
  matchAnswer: (m) => str(m.matchId) && bool(m.accept),
  matchMove: (m) => str(m.matchId) && obj(m.from) && obj(m.to),
  matchLeave: (m) => str(m.matchId),
  matchClear: (m) => str(m.matchId) && str(m.room) && str(m.seat),
  matchRobot: (m) => str(m.matchId) && str(m.room) && str(m.seat),
  startMatch: (m) => str(m.matchId),
  matchRule: (m) => str(m.matchId) && Number.isInteger(m.seq) && str(m.ruling) && str(m.team) && str(m.reason),
  matchPause: (m) => str(m.matchId) && bool(m.paused),
  matchAbandon: (m) => str(m.matchId),
  matchReplace: (m) => str(m.matchId) && str(m.room) && str(m.seat) && str(m.userId),
  matchSitIn: (m) => str(m.matchId) && str(m.room) && str(m.seat),
  sendDirect: (m) => str(m.to) && str(m.text),
  readDirect: (m) => str(m.userId),
}

/**
 * Reads one WebSocket message from the browser: size, JSON, an object with a plain `type`, and the
 * field types of known messages. Anything else is answered with an `error` and never reaches a handler
 */
export function parseClientMessage(raw: string): { message: ClientMessage } | { error: MessageCode } {
  if (raw.length > MESSAGE_MAX_CHARS) return { error: 'messageTooLarge' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { error: 'badMessage' }
  }
  if (!obj(data)) return { error: 'badMessage' }
  const fields = data as Fields
  if (typeof fields.type !== 'string' || !/^[A-Za-z]{1,40}$/.test(fields.type)) return { error: 'badMessage' }
  const guard = Object.hasOwn(GUARDS, fields.type) ? GUARDS[fields.type as ClientMessage['type']] : undefined
  if (guard && !guard(fields)) return { error: 'badMessage' }
  return { message: fields as ClientMessage }
}
