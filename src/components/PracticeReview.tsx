import { useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import type { AuctionCall } from '../../shared/auction.ts'
import { hcp, rankLabel, rankOf, rankValue, SEATS, SUITS, suitOf, type Card, type Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import type { BoardView, PracticeReview as Review, PracticeReviewStep } from '../../shared/protocol.ts'
import { ddOutcome, robotGain, type DdOutcome } from '../lib/practiceReview.ts'
import { useDoubleDummy } from '../lib/useDoubleDummy.ts'
import { useRobotRules } from '../lib/useRobotRules.ts'
import { signed } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'
import { DoubleDummyPanel } from './DoubleDummyPanel.tsx'
import { CallLabel, ContractLabel, ContractResult, SuitSymbol, SuitText } from './Suit.tsx'
import { Backdrop, Buttons, Panel } from './TableSettingsDialog.tsx'
import { Button, Muted } from './ui.tsx'

/**
 * 檢討 of a bidding practice's board (`e10-t07`, ARCHITECTURE.md §5.11): the four hands, every call
 * next to TKB's call at that point (marked where they differ; pick one for what both mean), the
 * auction four TKB make and how its contract compares double dummy, the DD table and par, and what
 * a deal set's board teaches. The calls come from the server once the auction is over
 * (`TablePractice.review`); the DD table is worked out here, as on the record page
 */

const Wide = styled(Panel)`
  max-width: 620px;

  & h3 {
    margin: ${({ theme }) => theme.space(4)} 0 ${({ theme }) => theme.space(2)};
    font-size: 16px;
    color: ${({ theme }) => theme.colors.text};
  }
`

const Hands = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 8px;
  font-variant-numeric: tabular-nums;
`

const Hand = styled.div`
  padding: 6px 8px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
  font-size: 14px;
  line-height: 1.5;

  & > strong { display: block; }
`

const Steps = styled.ol`
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Step = styled.button<{ $differs: boolean }>`
  display: grid;
  grid-template-columns: 2em 1fr 1fr 5em;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 2px 8px;
  border: 1px solid ${({ theme, $differs }) => ($differs ? theme.colors.danger : 'transparent')};
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $differs }) => ($differs ? theme.colors.dangerSoft : 'transparent')};
  color: ${({ theme }) => theme.colors.text};
  font: inherit;
  font-size: 15px;
  text-align: left;
  cursor: pointer;

  &[aria-pressed='true'] { outline: 2px solid ${({ theme }) => theme.colors.focus}; }
  & > em { color: ${({ theme }) => theme.colors.danger}; font-style: normal; font-size: 13px; font-weight: 700; }
`

const StepsHead = styled.div`
  display: grid;
  grid-template-columns: 2em 1fr 1fr 5em;
  padding: 0 9px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Explain = styled.dl`
  display: grid;
  gap: 4px;
  margin: ${({ theme }) => theme.space(2)} 0 0;
  padding: 8px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  font-size: 14px;

  & dt { font-weight: 700; }
  & dd { margin: 0 0 4px; }
`

const Calls = styled.p`
  margin: 0 0 ${({ theme }) => theme.space(2)};
  font-size: 15px;
  line-height: 1.6;
`

const Outcomes = styled.ul`
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 15px;
`

const Gain = styled.p`
  margin: ${({ theme }) => theme.space(2)} 0 0;
  font-weight: 700;
`

const Teaches = styled.p`
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-line;

  & > strong { display: block; }
`

/** A hand as four lines, the suits from the top, the cards high to low */
function HandText({ seat, cards, name }: { seat: Seat; cards: readonly Card[]; name?: string }) {
  const { t } = usePreferences()
  return (
    <Hand aria-label={t.seatNames[seat]}>
      <strong>
        {t.seatNames[seat]}
        {name && ` ${name}`} · {hcp(cards)}
      </strong>
      {SUITS.map((suit) => {
        const ranks = cards
          .filter((card) => suitOf(card) === suit)
          .map(rankOf)
          .sort((a, b) => rankValue(b) - rankValue(a))
        return (
          <div key={suit}>
            <SuitSymbol suit={suit} /> {ranks.length ? ranks.map(rankLabel).join(' ') : '—'}
          </div>
        )
      })}
    </Hand>
  )
}

/** What a call made at the table shows: a robot's or the engine's reading of a person's, or its alert */
function useMeaning() {
  const { t, lang } = usePreferences()
  const rules = useRobotRules(true)
  return {
    ofCall(call: AuctionCall): string {
      const described = call.meaning && rules ? rules.describe(call.meaning, lang) : undefined
      if (call.inferred) return `${t.inferredBy(t.robotSystems[call.inferred])}${t.colon}${described ?? '…'}`
      return described || call.alert || t.noExplanation
    },
    ofStep(step: PracticeReviewStep): string {
      if (!step.meaning) return t.noExplanation
      return rules ? rules.describe(step.meaning, lang) || t.noExplanation : '…'
    },
  }
}

function Outcome({ who, contract, outcome }: { who: string; contract: BoardView['contract']; outcome: DdOutcome | null }) {
  const { t } = usePreferences()
  return (
    <li>
      <strong>{who}</strong>{' '}
      {contract && outcome?.tricks != null ? <ContractResult contract={contract} tricks={outcome.tricks} /> : <ContractLabel contract={contract} />}
      {outcome && (
        <>
          {outcome.tricks != null && ` · ${t.practiceReview.ddTricks(outcome.tricks)}`} · NS {signed(outcome.scoreNS)}
        </>
      )}
    </li>
  )
}

export function PracticeReview({
  board,
  review,
  note,
  names,
  onClose,
}: {
  /** The board, finished at the end of its auction: all four hands are open */
  board: BoardView
  review: Review | undefined
  /** What a deal set's board teaches */
  note?: string
  names?: Partial<Record<Seat, string>>
  onClose: () => void
}) {
  const { t } = usePreferences()
  const r = t.practiceReview
  const titleId = useId()
  const [picked, setPicked] = useState<number | null>(null)
  const meaning = useMeaning()
  // The DD table wants the board as a record has it: the four hands, nothing played
  const state: BoardState = {
    boardNo: board.boardNo,
    dealer: board.dealer,
    vul: board.vul,
    hands: { N: board.hands.N ?? [], E: board.hands.E ?? [], S: board.hands.S ?? [], W: board.hands.W ?? [] },
    auction: board.auction,
    contract: board.contract,
    play: [],
    phase: 'finished',
  }
  const [solving] = useState(() => state)
  const dd = useDoubleDummy(solving)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const steps = review?.steps
  const robot = review?.robot
  const table = dd.status === 'done' ? dd.analysis.table : null
  const actualOutcome = table && ddOutcome(board.contract, table, board.vul)
  const robotOutcome = table && robot ? ddOutcome(robot.contract, table, board.vul) : null
  const chosen = picked === null ? null : board.auction[picked]

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Wide role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>
          {r.title} · <ContractLabel contract={board.contract} />
        </h2>
        {note && (
          <Teaches>
            <strong>{t.practiceNote}</strong>
            {note}
          </Teaches>
        )}

        <section aria-label={r.hands}>
          <h3>{r.hands}</h3>
          <Hands>
            {SEATS.map((seat) => (
              <HandText key={seat} seat={seat} cards={state.hands[seat]} name={names?.[seat]} />
            ))}
          </Hands>
        </section>

        <section aria-label={r.steps}>
          <h3>{r.steps}</h3>
          <Muted>{r.stepsHint}</Muted>
          {!steps ? (
            <Muted role="status">{r.working}</Muted>
          ) : (
            <>
              <StepsHead aria-hidden>
                <span>{r.seat}</span>
                <span>{r.actual}</span>
                <span>{r.robot}</span>
              </StepsHead>
              <Steps>
                {board.auction.map((call, i) => {
                  const step = steps[i]
                  const differs = !!step && step.call !== call.call
                  return (
                    <li key={i}>
                      <Step
                        type="button"
                        $differs={differs}
                        aria-pressed={picked === i}
                        onClick={() => setPicked(picked === i ? null : i)}
                      >
                        <span>{seatLetter[call.seat]}</span>
                        <span data-testid="made">
                          <CallLabel call={call.call} />
                        </span>
                        <span data-testid="robot">{step ? <CallLabel call={step.call} /> : '…'}</span>
                        {differs ? <em>{r.differs}</em> : <span />}
                      </Step>
                    </li>
                  )
                })}
              </Steps>
              {chosen && picked !== null && (
                <Explain role="region" aria-label={r.meaningOf(t.seatNames[chosen.seat])}>
                  <dt>
                    {r.meaningOf(t.seatNames[chosen.seat])}{t.colon}<CallLabel call={chosen.call} />
                  </dt>
                  <dd><SuitText text={meaning.ofCall(chosen)} /></dd>
                  {steps[picked] && (
                    <>
                      <dt>
                        {r.robotMeaning}{t.colon}<CallLabel call={steps[picked].call} />
                      </dt>
                      <dd><SuitText text={meaning.ofStep(steps[picked])} /></dd>
                    </>
                  )}
                </Explain>
              )}
            </>
          )}
        </section>

        <section aria-label={r.robotBidding}>
          <h3>{r.robotBidding}</h3>
          <Muted>{r.robotBiddingHint}</Muted>
          {!robot ? (
            <Muted role="status">{r.working}</Muted>
          ) : (
            <>
              <Calls data-testid="robot-auction">
                {robot.auction.map((call, i) => (
                  <span key={i}>
                    {i > 0 && ' – '}
                    {seatLetter[call.seat]} <CallLabel call={call.call} />
                  </span>
                ))}
              </Calls>
              <Outcomes>
                <Outcome who={r.yours} contract={board.contract} outcome={actualOutcome} />
                <Outcome who={r.robot} contract={robot.contract} outcome={robotOutcome} />
              </Outcomes>
              {actualOutcome && robotOutcome && <Gain role="status">{r.gain(robotGain(actualOutcome, robotOutcome))}</Gain>}
            </>
          )}
        </section>

        <section aria-label={r.dd}>
          <h3>{r.dd}</h3>
          <DoubleDummyPanel board={solving} />
        </section>

        <Buttons>
          <Button type="button" onClick={onClose}>
            {t.close}
          </Button>
        </Buttons>
      </Wide>
    </Backdrop>
  )
}
