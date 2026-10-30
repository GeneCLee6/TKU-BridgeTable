import { useEffect, useState } from 'react'

/** Pause between the cards of a trick during a replay */
export const REPLAY_CARD_MS = 550

/**
 * BBO's movie controls for a finished board: one step is one trick. "Next" plays the four cards of
 * the next trick one after another, a moment apart, and the controls wait until the trick is
 * complete; "previous" goes straight back to the trick before. `step` is the number of cards shown.
 * `nextCard` / `prevCard` move one card instead (double-dummy mode, as BBO's movie does).
 * `gaps` (照實際速度, `e2-t33`): how long to wait before each card instead of `delay`, as long as it
 * was played at the table; `play` then runs the rest of the board, `pause` stops it.
 */
export function useTrickReplay(total: number, delay = REPLAY_CARD_MS, gaps?: readonly number[]) {
  const [step, setStep] = useState(0)
  // The card the replay is heading for; while step < target the cards come out one by one
  const [target, setTarget] = useState(0)

  useEffect(() => {
    if (step >= target) return
    const timer = setTimeout(() => setStep((s) => s + 1), gaps?.[step] ?? delay)
    return () => clearTimeout(timer)
  }, [step, target, delay, gaps])

  const playing = step < target
  const jump = (n: number) => {
    const to = Math.max(0, Math.min(total, n))
    setStep(to)
    setTarget(to)
  }

  return {
    step,
    playing,
    /** The trick on the table (0 before the first card) and how many there are */
    trick: Math.ceil(step / 4),
    tricks: Math.ceil(total / 4),
    next: () => {
      if (playing || step >= total) return
      // The first card shows at once, the rest follow
      setStep(step + 1)
      setTarget(Math.min(total, (Math.floor(step / 4) + 1) * 4))
    },
    prev: () => {
      if (playing) return
      jump((Math.ceil(step / 4) - 1) * 4)
    },
    /** Double-dummy mode steps one card at a time, so every hand gets its turn to be analysed */
    nextCard: () => {
      if (!playing) jump(step + 1)
    },
    prevCard: () => {
      if (!playing) jump(step - 1)
    },
    /** Plays the rest of the board, card after card */
    play: () => {
      if (step >= total) return
      setTarget(total)
    },
    /** Stops where it is */
    pause: () => setTarget(step),
    start: () => jump(0),
    end: () => jump(total),
    jump,
  }
}
