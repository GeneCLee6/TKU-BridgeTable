import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { makeCall, newBoard, turnOf } from '../../shared/game.ts'
import { chooseCall } from '../../shared/robot/bidding.ts'
import { choose } from '../../shared/robot/system/engine.ts'
import { contextFor } from '../../shared/robot/system/infer.ts'
import { bookFits } from '../../shared/robot/system/rules.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { target } from '../../shared/robot/system/tku/target.ts'

/**
 * While the club's rules move into the system engine (e5-t15 to e5-t18), the books already moved
 * must bid exactly as `bidding.ts` does. Calls the books do not cover yet go to the fallback and
 * are left out.
 */

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

describe('the club’s books in the system engine', () => {
  it('bid as bidding.ts does on 1,000 random boards', () => {
    let compared = 0
    for (let seed = 1; seed <= 1000; seed++) {
      let state = newBoard(seed, deal(seeded(seed)))
      while (state.phase === 'auction') {
        const seat = turnOf(state)!
        const old = chooseCall(state.hands[seat], seat, state.auction, state.dealer, state.vul)
        const ctx = contextFor(TKU, seat, state.auction, state.dealer, state.vul)
        const book = TKU.books.find((b) => bookFits(b, ctx))
        if (book && book !== target && !book.more) {
          compared++
          const call = choose(TKU, state.hands[seat], seat, state.auction, state.dealer, state.vul).call
          expect(call, `board ${seed} [${state.auction.map((c) => c.call).join(' ')}]`).toBe(old.call)
        }
        state = makeCall(state, seat, old.call, old.alert)
      }
    }
    expect(compared).toBeGreaterThan(1000)
  })
})
