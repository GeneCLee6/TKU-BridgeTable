import { describe, expect, it } from 'vitest'
import { withMemberProfile } from '../../shared/lobby.ts'
import { BUILTIN_BOARDS, COMMENT_BLOCK_KINDS, FORUM_LIMITS, NEWS_BOARD_ID, POST_BLOCK_KINDS, REACTION_EMOJIS } from '../../shared/forum.ts'

describe('forum types (TKU-BridgeHall e11-t05)', () => {
  it('starts with four boards, only officers posting news', () => {
    expect(BUILTIN_BOARDS.map((b) => b.id)).toEqual(['news', 'deals', 'systems', 'chat'])
    expect(BUILTIN_BOARDS.filter((b) => b.postPolicy === 'officers').map((b) => b.id)).toEqual([NEWS_BOARD_ID])
    expect(BUILTIN_BOARDS.map((b) => b.order)).toEqual([0, 1, 2, 3])
  })

  it('has the five reactions and comment blocks that posts also have', () => {
    expect(REACTION_EMOJIS).toEqual(['👍', '♠', '♥', '♦', '♣'])
    for (const kind of COMMENT_BLOCK_KINDS) expect(POST_BLOCK_KINDS).toContain(kind)
    expect(new Set(POST_BLOCK_KINDS).size).toBe(POST_BLOCK_KINDS.length)
    expect(FORUM_LIMITS).toMatchObject({ blocksMax: 20, postTextMax: 5000, imagesMax: 6, commentTextMax: 1000, perMinute: 5, pageSize: 20 })
  })
})

describe('withMemberProfile (e11-t19)', () => {
  const members = [{ id: 'amy', username: 'amy', avatar: 7, displayName: '王小美' }]
  it("takes a seat's picture and display name from the lobby", () => {
    expect(withMemberProfile({ id: 'amy', username: 'amy', online: true }, members)).toEqual({
      id: 'amy',
      username: 'amy',
      online: true,
      avatar: 7,
      displayName: '王小美',
    })
  })
  it('leaves robots, empty seats and strangers alone', () => {
    const robot = { id: 'robot:tku:1', username: 'TKB', robot: true }
    expect(withMemberProfile(robot, members)).toBe(robot)
    expect(withMemberProfile(null, members)).toBeNull()
    const ben = { id: 'ben', username: 'ben' }
    expect(withMemberProfile(ben, members)).toBe(ben)
    expect(withMemberProfile(ben, undefined)).toBe(ben)
  })
})
