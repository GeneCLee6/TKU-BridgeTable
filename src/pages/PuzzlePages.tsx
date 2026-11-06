import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { nextSeat, type Seat } from '../../shared/cards.ts'
import { PUZZLE_LEVELS, replayPuzzle, type PuzzleAnswer, type PuzzleAttemptStatus, type PuzzleSummary, type PuzzleView } from '../../shared/puzzles.ts'
import { CardList } from '../components/CardList.tsx'
import { HandView } from '../components/HandView.tsx'
import { SuitSymbol } from '../components/Suit.tsx'
import { TrickArea, type Position } from '../components/TrickArea.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { seatLetter } from '../strings.ts'

/**
 * 謎題 (`e10-t14`, AC-10.9, ARCHITECTURE.md §5.11): the published puzzles by level with the member's
 * progress (`/puzzles`) and one puzzle (`/puzzles/:puzzleId`). The pages only show: which cards may be
 * played and whether a card was right comes from the server (`PuzzleService`, `puzzleView`), and
 * East's and West's cards arrive only when the puzzle is solved or the member asks for the answer,
 * which then no longer counts as solved. The puzzles' own words are in 繁體中文; in any other language the page says so and shows them as they are.
 */

const CARD_WIDTH = 46

const Stack = styled.div`
  display: grid;
  gap: 16px;
  margin-top: 16px;
`

const Rows = styled.ul`
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const Row = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 10px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
`

const Solved = styled.strong`
  color: ${({ theme }) => theme.colors.success};
`

/** A puzzle whose answer was viewed: not solved, and not to be mistaken for it */
const Revealed = styled.strong`
  color: ${({ theme }) => theme.colors.accentStrong};
`

const RevealedVerdict = styled.p`
  margin: 0;
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme }) => theme.colors.accentSoft};
`

const Felt = styled.div`
  display: grid;
  grid-template: auto auto auto / minmax(0, 1fr) auto minmax(0, 1fr);
  grid-template-areas: '. north .' 'west middle east' '. south .';
  align-items: center;
  justify-items: center;
  gap: 8px;
  padding: 16px 8px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.table.felt};
  color: ${({ theme }) => theme.table.feltText};
`

/** The trick's cards stand out past their box, so the middle keeps clear of the hands above and below */
const Place = styled.div<{ $area: string; $roomy?: boolean }>`
  grid-area: ${({ $area }) => $area};
  ${({ $roomy }) => $roomy && 'padding: 28px 0;'}
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
`

const Facts = styled.dl`
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0;

  & dt {
    color: ${({ theme }) => theme.colors.textMuted};
  }
  & dd {
    margin: 0;
  }
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

const Verdict = styled.p<{ $good: boolean }>`
  margin: 0;
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $good }) => ($good ? theme.colors.successSoft : theme.colors.dangerSoft)};
`

const Paragraph = styled.p`
  margin: 0;
  white-space: pre-wrap;
`

/** The note that a puzzle's own words are 繁中, in every other language */
function WordsNote() {
  const { t, lang } = usePreferences()
  return lang === 'zh' ? null : <Muted>{t.puzzles.zhOnly}</Muted>
}

function useStatusWord() {
  const { t } = usePreferences()
  const words: Record<PuzzleAttemptStatus, string> = {
    new: t.puzzles.statusNew,
    playing: t.puzzles.statusPlaying,
    failed: t.puzzles.statusFailed,
    solved: t.puzzles.statusSolved,
    revealed: t.puzzles.statusRevealed,
  }
  return words
}

export function PuzzleListPage() {
  const { t, message } = usePreferences()
  const p = t.puzzles
  const words = useStatusWord()
  const [puzzles, setPuzzles] = useState<PuzzleSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.puzzles().then(
      ({ puzzles }) => setPuzzles(puzzles),
      (e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError),
    )
  }, [message, t.genericError])

  return (
    <PageMain>
      <PageTitle>{p.title}</PageTitle>
      <Muted>{p.intro}</Muted>
      <WordsNote />
      <Stack>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        {!puzzles && !error && <Muted role="status">{t.loading}</Muted>}
        {puzzles?.length === 0 && <Muted>{p.none}</Muted>}
        {puzzles &&
          PUZZLE_LEVELS.map((level) => {
            const inLevel = puzzles.filter((puzzle) => puzzle.level === level)
            if (inLevel.length === 0) return null
            return (
              <Card key={level}>
                <h2>{p.level(level)}</h2>
                <Muted>{p.levelProgress(inLevel.filter((puzzle) => puzzle.solved).length, inLevel.length)}</Muted>
                <Rows>
                  {inLevel.map((puzzle) => (
                    <Row key={puzzle.id}>
                      <Link to={`/puzzles/${encodeURIComponent(puzzle.id)}`}>{puzzle.title}</Link>
                      <span>
                        {puzzle.contract.level}
                        <SuitSymbol suit={puzzle.contract.strain} />
                        {' · '}
                        {puzzle.solved ? <Solved>{puzzle.clean ? p.clean : p.statusSolved}</Solved> : puzzle.revealed ? <Revealed>{p.statusRevealed}</Revealed> : words[puzzle.status]}
                      </span>
                    </Row>
                  ))}
                </Rows>
              </Card>
            )
          })}
      </Stack>
    </PageMain>
  )
}

const POSITIONS: Record<Seat, Position> = { N: 'top', E: 'right', S: 'bottom', W: 'left' }

/** The table: North and South open and playable on their turn, East and West face down until solved or revealed */
function PuzzleTable({ puzzle, busy, onPlay }: { puzzle: PuzzleView; busy: boolean; onPlay: (card: string) => void }) {
  const { t } = usePreferences()
  const p = t.puzzles
  const last = puzzle.tricks.at(-1)
  const cards = last ? last.cards.map((card, i) => ({ seat: nextSeat(last.leader, i), card })) : []
  const hand = (seat: Seat, label: string) => (
    <HandView
      cards={puzzle.hands[seat]}
      count={puzzle.counts[seat]}
      width={seat === 'N' || seat === 'S' ? CARD_WIDTH : Math.round(CARD_WIDTH * 0.7)}
      orientation={seat === 'N' || seat === 'S' ? 'horizontal' : 'rows'}
      playable={!busy && puzzle.turn === seat ? puzzle.legalCards : []}
      onPlay={onPlay}
      label={label}
    />
  )
  const side = (seat: Seat) => (puzzle.hands[seat] ? p.openHand(seatLetter[seat]) : p.hiddenHand(seatLetter[seat]))
  return (
    <Felt>
      <Place $area="north">
        {hand('N', p.dummy)}
        <span>{p.dummy}</span>
      </Place>
      <Place $area="west">
        {hand('W', side('W'))}
        <span>{side('W')}</span>
      </Place>
      <Place $area="middle" $roomy>
        <TrickArea cards={cards} positionOf={(seat) => POSITIONS[seat]} winner={last?.winner} width={CARD_WIDTH} label={p.trick} />
      </Place>
      <Place $area="east">
        {hand('E', side('E'))}
        <span>{side('E')}</span>
      </Place>
      <Place $area="south">
        {hand('S', p.declarer)}
        <span>{p.declarer}</span>
      </Place>
    </Felt>
  )
}

/** The table as it stood after this many of the answer's cards, worked out from what the server sent; nothing here can be played */
function answerTable(puzzle: PuzzleView, answer: PuzzleAnswer, step: number): PuzzleView {
  if (!puzzle.startHands) return puzzle
  const state = replayPuzzle(puzzle.startHands, puzzle.contract.strain, answer.leader, answer.line.slice(0, step))
  return {
    ...puzzle,
    hands: state.hands,
    counts: { N: state.hands.N.length, E: state.hands.E.length, S: state.hands.S.length, W: state.hands.W.length },
    tricks: state.tricks,
    turn: null,
    legalCards: [],
  }
}

/** One card at a time through the answer; the table above shows where it has got to */
function AnswerSteps({ answer, step, onStep }: { answer: PuzzleAnswer; step: number; onStep: (step: number) => void }) {
  const { t } = usePreferences()
  const p = t.puzzles
  const total = answer.line.length
  return (
    <>
      <h3>{p.answerTitle}</h3>
      <Muted>{p.answerIntro}</Muted>
      <CardList cards={answer.line} />
      <Actions>
        <Button type="button" disabled={step <= answer.first} onClick={() => onStep(step - 1)}>
          {p.answerPrev}
        </Button>
        <Button type="button" disabled={step >= total} onClick={() => onStep(step + 1)}>
          {p.answerNext}
        </Button>
      </Actions>
      <Muted role="status">{p.answerStep(step, total)}</Muted>
      {step >= total && <Muted>{p.answerEnd}</Muted>}
    </>
  )
}

export function PuzzlePage() {
  const { puzzleId } = useParams()
  const { t, message } = usePreferences()
  const p = t.puzzles
  const words = useStatusWord()
  const [puzzle, setPuzzle] = useState<PuzzleView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** How far through the answer the table shows; null is where the answer starts */
  const [answerStep, setAnswerStep] = useState<number | null>(null)

  const failed = useCallback((e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])
  useEffect(() => {
    if (puzzleId) api.puzzle(puzzleId).then(({ puzzle }) => setPuzzle(puzzle), failed)
  }, [puzzleId, failed])

  const run = async (action: () => Promise<{ puzzle: PuzzleView }>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setPuzzle((await action()).puzzle)
      setAnswerStep(null)
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  /** Having seen the answer or solved it, there is nothing left to lose: no need to ask */
  const reveal = (shown: PuzzleView, id: string) => {
    if (!shown.solved && !shown.revealed && !window.confirm(p.revealConfirm)) return
    void run(() => api.revealPuzzle(id))
  }

  const back = <Link to="/puzzles">{p.back}</Link>
  if (!puzzle || !puzzleId)
    return (
      <PageMain>
        <PageTitle>{p.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted role="status">{t.loading}</Muted>}
        {back}
      </PageMain>
    )

  const step = puzzle.answer ? (answerStep ?? puzzle.answer.first) : 0
  return (
    <PageMain>
      <PageTitle>{puzzle.title}</PageTitle>
      {back}
      <WordsNote />
      <Stack>
        <Card>
          <Paragraph>{puzzle.story}</Paragraph>
          <Facts>
            <dt>{p.contract}</dt>
            <dd>
              {puzzle.contract.level}
              <SuitSymbol suit={puzzle.contract.strain} /> {seatLetter.S} · {p.level(puzzle.level)}
            </dd>
            <dt>{p.tricksLabel}</dt>
            <dd>{p.tally(puzzle.wonBefore, puzzle.won, puzzle.need)}</dd>
            <dt>{p.goneCards}</dt>
            <dd>{puzzle.gone.length > 0 ? <CardList cards={puzzle.gone} /> : p.goneNone}</dd>
          </Facts>
        </Card>
        <PuzzleTable puzzle={puzzle.answer ? answerTable(puzzle, puzzle.answer, step) : puzzle} busy={busy} onPlay={(card) => void run(() => api.playPuzzle(puzzleId, card))} />
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Card>
          {puzzle.status === 'solved' && <Verdict $good role="status">{p.solved}</Verdict>}
          {puzzle.status === 'revealed' && (
            <RevealedVerdict role="status">{puzzle.solved ? p.revealedKept : puzzle.finishedAfterReveal ? p.revealedFinished : p.revealedNote}</RevealedVerdict>
          )}
          {puzzle.revealed && !puzzle.solved && puzzle.status !== 'revealed' && <Muted>{p.revealedRetrying}</Muted>}
          {puzzle.status === 'failed' && puzzle.wrong && (
            <Verdict $good={false} role="alert">
              <CardList cards={[puzzle.wrong]} /> {p.wrongCard}
            </Verdict>
          )}
          {puzzle.turn && puzzle.status !== 'failed' && <Muted role="status">{p.yourTurn(seatLetter[puzzle.turn])}</Muted>}
          <Actions>
            {puzzle.status === 'failed' && (
              <Button type="button" $variant="primary" disabled={busy} onClick={() => void run(() => api.retryPuzzle(puzzleId, 'mistake'))}>
                {p.takeBack}
              </Button>
            )}
            {puzzle.status !== 'new' && (
              <Button type="button" disabled={busy} onClick={() => void run(() => api.retryPuzzle(puzzleId, 'start'))}>
                {p.restart}
              </Button>
            )}
            {puzzle.status !== 'solved' && puzzle.status !== 'revealed' && (
              <Button type="button" disabled={busy || puzzle.hintsLeft === 0} onClick={() => void run(() => api.puzzleHint(puzzleId))}>
                {puzzle.hintsLeft === 0 ? p.noHints : p.hintButton}
              </Button>
            )}
            {!puzzle.answer && (
              <Button type="button" disabled={busy} onClick={() => reveal(puzzle, puzzleId)}>
                {p.revealButton}
              </Button>
            )}
          </Actions>
          {puzzle.hints.length > 0 && (
            <>
              <h3>{p.hintsTitle}</h3>
              {puzzle.hints.map((hint) => (
                <Paragraph key={hint}>{hint}</Paragraph>
              ))}
            </>
          )}
          {puzzle.answer && <AnswerSteps answer={puzzle.answer} step={step} onStep={setAnswerStep} />}
          {puzzle.explanation && (
            <>
              <h3>{p.explanationTitle}</h3>
              <Paragraph>{puzzle.explanation}</Paragraph>
            </>
          )}
          {puzzle.startHands && (
            <>
              <h3>{p.startHands}</h3>
              <Facts>
                {(['N', 'E', 'S', 'W'] as const).map((seat) => (
                  <div key={seat} style={{ display: 'contents' }}>
                    <dt>{seatLetter[seat]}</dt>
                    <dd>
                      <CardList cards={puzzle.startHands?.[seat] ?? []} />
                    </dd>
                  </div>
                ))}
              </Facts>
            </>
          )}
          <Muted>
            {words[puzzle.status]} · {p.tried(puzzle.attempts, puzzle.failures)}
          </Muted>
        </Card>
      </Stack>
    </PageMain>
  )
}
