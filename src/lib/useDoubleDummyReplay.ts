import { useEffect, useMemo, useState } from 'react'
import type { Card } from '../../shared/cards.ts'
import type { BoardState, PlayedCard } from '../../shared/game.ts'
import { cardOutcomes, cardScores, ddPosition, positionKey, type CardOutcome, type DdPosition } from './doubleDummy.ts'
import { solvePosition } from './useDoubleDummy.ts'

/**
 * BBO's double-dummy mode in a replay: at the point the replay has reached, every card the hand to
 * play may play shows how the board ends for declarer if both sides play perfectly from there.
 * Clicking a card tries it out ("what if") and the analysis goes on from the new point; moving the
 * replay, or `reset`, goes back to the cards actually played. Only for finished boards, whose four
 * hands the record already shows (`canAnalyse`).
 */

export type DdStatus = 'off' | 'over' | 'loading' | 'done' | 'error'

export interface DdReplay {
  on: boolean
  status: DdStatus
  /** The cards on show: the record's up to the replay's step, then any tried out */
  play: PlayedCard[]
  /** Cards have been tried out beyond the actual play */
  whatIf: boolean
  position: DdPosition | null
  outcomes: ReadonlyMap<Card, CardOutcome> | null
  playCard: (card: Card) => void
  reset: () => void
}

type Answer = { key: string; scores: Map<Card, number> } | { key: string; error: true }

/**
 * `paused` holds back the solver while the replay is dealing out a trick card by card, so only the
 * point it stops at is solved
 */
export function useDoubleDummyReplay(board: BoardState, step: number, on: boolean, paused = false): DdReplay {
  const [tried, setTried] = useState<{ board: BoardState; step: number; cards: PlayedCard[] } | null>(null)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const extra = useMemo(() => (on && tried && tried.board === board && tried.step === step ? tried.cards : []), [on, tried, board, step])
  const play = useMemo(() => [...board.play.slice(0, step), ...extra], [board, step, extra])
  const position = useMemo(() => (on ? ddPosition(board, play) : null), [on, board, play])
  const key = position ? positionKey(position.request) : null

  useEffect(() => {
    if (!position || !key || paused) return
    let live = true
    const { result, cancel } = solvePosition(position.request)
    result.then(
      (raw) => live && setAnswer({ key, scores: cardScores(raw) }),
      () => live && setAnswer({ key, error: true }),
    )
    return () => {
      live = false
      cancel()
    }
    // `key` stands for the position: the same cards left give the same request
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, paused])

  const current = answer && answer.key === key ? answer : null
  const outcomes = useMemo(
    () => (position && current && 'scores' in current ? cardOutcomes(position, current.scores, board.contract!.level) : null),
    [position, current, board.contract],
  )
  const status: DdStatus = !on ? 'off' : !position ? 'over' : !current ? 'loading' : 'error' in current ? 'error' : 'done'

  return {
    on,
    status,
    play,
    whatIf: extra.length > 0,
    position,
    outcomes,
    playCard: (card) => {
      if (!position?.legal.includes(card)) return
      setTried({ board, step, cards: [...extra, { seat: position.turn, card }] })
    },
    reset: () => setTried(null),
  }
}
