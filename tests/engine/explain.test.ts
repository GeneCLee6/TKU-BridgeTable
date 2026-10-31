import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { makeCall, newBoard, turnOf } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { ROBOT_SYSTEMS, inferredMeaning, robotCall } from '../../shared/robot/robots.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { SUITS } from '../../shared/cards.ts'
import type { Range, Spec } from '../../shared/robot/system/spec.ts'
import { HEAVY_MS } from './heavy.ts'

/**
 * The explanation shown for a call (the bidding box hint, `explain`; a person's call read by the
 * engine, `inferredMeaning`) must agree with the rule that makes TKB bid it: the hint is the union
 * of every rule for the call, so each feature of the choosing rule lies inside the hint's, and a
 * convention name or an artificial call is never explained as something else. Both systems, over
 * random auctions bid by four robots.
 */

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

const inside = (part: Range | undefined, whole: Range | undefined) => !whole || (!!part && part[0] >= whole[0] && part[1] <= whole[1])

/** Whether what one rule shows (`rule`) fits what the explanation shows (`hint`) */
function agrees(rule: Spec, hint: Spec): string | null {
  if (hint.name && hint.name !== rule.name) return `name ${hint.name} vs ${rule.name}`
  if (hint.artificial && !rule.artificial) return 'artificial vs natural'
  if (!inside(rule.hcp, hint.hcp)) return `hcp ${rule.hcp} vs ${hint.hcp}`
  if (!inside(rule.tp, hint.tp)) return `tp ${rule.tp} vs ${hint.tp}`
  for (const s of SUITS) if (!inside(rule.len?.[s], hint.len?.[s])) return `len ${s} ${rule.len?.[s]} vs ${hint.len?.[s]}`
  if (hint.forcing && !rule.forcing) return `forcing ${hint.forcing} vs none`
  return null
}

const KINDS: RobotKind[] = ['tku', 'gib']

describe('the explanation of a call agrees with the rule TKB bids it by', () => {
  it('on 150 random auctions in each system', { timeout: HEAVY_MS }, () => {
    for (const kind of KINDS) {
      const system = ROBOT_SYSTEMS[kind]
      for (let seed = 1; seed <= 150; seed++) {
        let state = newBoard(seed, deal(seeded(seed)))
        while (state.phase === 'auction') {
          const seat = turnOf(state)!
          const bid = robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul)
          const choice = choose(system, state.hands[seat], seat, state.auction, state.dealer, state.vul)
          expect(choice.call).toBe(bid.call)
          if (bid.call !== 'P') {
            const label = `${kind} board ${seed}: ${state.auction.map((c) => c.call).join(' ')} → ${bid.call}`
            const hint = explain(system, state.auction, state.dealer, state.vul).get(bid.call)
            expect(hint, `${label}: no explanation`).toBeDefined()
            expect(bid.meaning, `${label}: no meaning`).toBeDefined()
            expect(agrees(bid.meaning!, hint!), `${label}: ${words(hint!, 'zh')} vs ${words(bid.meaning!, 'zh')}`).toBeNull()
            // A person making the same call is read the same way
            const made = [...state.auction, { seat, call: bid.call }]
            expect(inferredMeaning(kind, made, state.dealer, state.vul)).toEqual(hint)
          }
          state = makeCall(state, seat, bid.call, bid.alert)
        }
      }
    }
  })

  it('1♥–1♠–1NT–2♣ is new minor forcing in both systems, however many passes came first', () => {
    for (const kind of KINDS) {
      for (const before of [[], ['P'], ['P', 'P'], ['P', 'P', 'P']]) {
        const calls = [...before, '1H', 'P', '1S', 'P', '1N', 'P']
        const auction = calls.map((call, i) => ({ seat: (['N', 'E', 'S', 'W'] as const)[i % 4], call }))
        const hint = explain(ROBOT_SYSTEMS[kind], auction, 'N', 'None').get('2C')
        expect(hint, `${kind} after ${calls.join(' ')}`).toMatchObject({ name: 'newMinorForcing', artificial: true, forcing: 'oneRound' })
        expect(words(hint!, 'zh')).toMatch(/^新低花迫叫/)
      }
    }
  })
})
