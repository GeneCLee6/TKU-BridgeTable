/**
 * Every message the server can send a user, in both languages. The server sends the code (plus
 * parameters) and the browser shows it in the viewer's language; `Error.message` keeps the
 * Chinese text for logs and tests. Placeholders look like {max}.
 */
export const MESSAGES = {
  // Bidding and play
  auctionOver: { zh: '叫牌已經結束', en: 'The auction is over' },
  notYourCall: { zh: '還沒輪到你叫牌', en: 'It is not your turn to call' },
  illegalCall: { zh: '不合法的叫品', en: 'That call is not allowed' },
  cannotPlayNow: { zh: '現在不能出牌', en: 'You cannot play a card now' },
  claimPending: { zh: '請先處理攤牌', en: 'Answer the claim first' },
  notThisHandsTurn: { zh: '還沒輪到這家出牌', en: 'It is not this hand’s turn' },
  cardNotHeld: { zh: '手上沒有這張牌', en: 'That card is not in the hand' },
  mustFollowSuit: { zh: '必須跟出同花色', en: 'You must follow suit' },
  cannotClaimNow: { zh: '現在不能攤牌', en: 'You cannot claim now' },
  dummyCannotClaim: { zh: '夢家不能攤牌', en: 'Dummy cannot claim' },
  alreadyClaimed: { zh: '已經有人攤牌', en: 'A claim is already pending' },
  claimAtTrickEnd: { zh: '請在一墩結束後再攤牌', en: 'Claim at the end of a trick' },
  badClaim: { zh: '墩數不合理', en: 'That number of tricks is not possible' },
  noClaim: { zh: '沒有待處理的攤牌', en: 'There is no claim to answer' },
  notClaimApprover: { zh: '你不需要回應這次攤牌', en: 'You do not need to answer this claim' },
  boardOver: { zh: '這副牌已經結束', en: 'This board is over' },
  nothingToUndo: { zh: '沒有可以撤回的動作', en: 'There is nothing to undo' },
  notYourCard: { zh: '這不是你可以出的牌', en: 'You cannot play that card' },
  unknownCard: { zh: '不認得這張牌', en: 'Unknown card' },
  undoOwnOnly: { zh: '只能撤回自己剛做的動作', en: 'You can only undo your own last action' },
  undoByOpponent: { zh: '要由對手回應撤回', en: 'An opponent must answer the undo request' },

  // Tables
  badSeat: { zh: '座位不正確', en: 'Unknown seat' },
  unknownCommand: { zh: '不認得的指令', en: 'Unknown command' },
  tableGone: { zh: '找不到這張牌桌，可能已經關閉', en: 'That table no longer exists' },
  seatTaken: { zh: '這個位子已經有人了', en: 'That seat is taken' },
  noSeatChange: { zh: '牌局進行中不能換位子', en: 'You cannot change seats during a board' },
  notAtTable: { zh: '你不在牌桌上', en: 'You are not at a table' },
  notSeated: { zh: '你沒有坐在牌桌上', en: 'You are not seated' },
  freeOfflineOnly: { zh: '只能請離線的玩家離座', en: 'Only an offline player can be removed' },
  noBoard: { zh: '還沒有發牌', en: 'No board has been dealt yet' },
  seatNotRobot: { zh: '這個位子不是機器人', en: 'That seat is not a robot' },
  needHuman: { zh: '牌桌上至少要有一位真人', en: 'At least one person must stay at the table' },

  // Accounts
  signInFirst: { zh: '請先登入', en: 'Please sign in' },
  signInAgain: { zh: '請重新登入', en: 'Please sign in again' },
  badInvite: { zh: '邀請碼不正確', en: 'Wrong invite code' },
  memberCap: { zh: '社團帳號已達上限（{max} 人）', en: 'The club is full ({max} accounts)' },
  badUsername: {
    zh: '帳號需為 {min}–{max} 個字，只能用中英文、數字與 _ . -',
    en: 'Usernames are {min}–{max} characters: letters, digits, _ . -',
  },
  shortPassword: { zh: '密碼至少 {min} 個字', en: 'Passwords need at least {min} characters' },
  usernameTaken: { zh: '這個帳號已經有人使用', en: 'That username is taken' },
  badLogin: { zh: '帳號或密碼錯誤', en: 'Wrong username or password' },
  wrongPassword: { zh: '目前的密碼不正確', en: 'Your current password is wrong' },

  // Admin
  adminOnly: { zh: '只有管理員可以使用', en: 'Admins only' },
  userGone: { zh: '找不到這個帳號', en: 'No such account' },
  notSelf: { zh: '不能對自己的帳號這樣做', en: 'You cannot do that to your own account' },
  lastAdmin: { zh: '至少要保留一位管理員', en: 'The club needs at least one admin' },
  badCap: { zh: '人數上限需在 {min}–{max} 之間', en: 'The limit must be between {min} and {max}' },

  // HTTP
  boardGone: { zh: '找不到這副牌', en: 'No such board' },
  noSuchApi: { zh: '找不到這個 API', en: 'Unknown API' },
  serverError: { zh: '伺服器發生錯誤', en: 'Server error' },
} as const

export type MessageCode = keyof typeof MESSAGES
export type Lang = 'zh' | 'en'
export type MessageParams = Record<string, string | number>

export function formatMessage(code: MessageCode, lang: Lang, params: MessageParams = {}): string {
  const template: string = MESSAGES[code]?.[lang] ?? code
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

export const isMessageCode = (value: unknown): value is MessageCode =>
  typeof value === 'string' && value in MESSAGES

/** An error the user should see; GameError and ClubError extend it */
export class AppError extends Error {
  readonly code: MessageCode
  readonly params: MessageParams
  readonly status: number
  constructor(code: MessageCode, params: MessageParams = {}, status = 400) {
    super(formatMessage(code, 'zh', params))
    this.code = code
    this.params = params
    this.status = status
  }
}
