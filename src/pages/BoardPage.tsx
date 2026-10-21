import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { hcp, rankLabel, rankOf, SEATS, suitOf, type Seat } from '../../shared/cards.ts'
import { remainingCards, tricksOf } from '../../shared/game.ts'
import { handviewerUrl, toLin } from '../../shared/lin.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BoardInfo } from '../components/BoardInfo.tsx'
import { HandView } from '../components/HandView.tsx'
import { ContractLabel, SuitSymbol } from '../components/Suit.tsx'
import { TrickArea, TrickSpace, type Position } from '../components/TrickArea.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { cardName } from '../lib/cards.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile, mobileQuery } from '../styles/tokens.ts'
import { seatLetter } from '../strings.ts'

/**
 * One finished board: the deal as a hand diagram, the auction, and a card-by-card replay like
 * BBO's movie. North is always at the top here, as in a printed hand record.
 */

const POSITIONS: Record<Position, Seat> = { top: 'N', right: 'E', bottom: 'S', left: 'W' }
const positionOf = (seat: Seat) => (Object.keys(POSITIONS) as Position[]).find((p) => POSITIONS[p] === seat)!

const Columns = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 20px;
  align-items: start;

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Diagram = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  grid-template-areas:
    'info top .'
    'left center right'
    '. bottom .';
  gap: 10px;
  align-items: center;
  justify-items: center;
  padding: 16px;
  border-radius: ${({ theme }) => theme.radius.lg};
  background: radial-gradient(ellipse at center, ${({ theme }) => theme.table.felt} 55%, ${({ theme }) => theme.table.feltEdge});
  color: ${({ theme }) => theme.table.feltText};

  ${mobile} {
    padding: 10px 6px;
    gap: 6px;
  }
`

const Spot = styled.div<{ $area: string }>`
  grid-area: ${({ $area }) => $area};
  display: grid;
  justify-items: center;
  gap: 4px;
  min-width: 0;
  width: 100%;
`

const Name = styled.div`
  font-size: 15px;
  font-weight: 700;
`

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
`

const Meta = styled.dl`
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  margin: 0 0 12px;
  font-size: 15px;

  & > dt { color: ${({ theme }) => theme.colors.textMuted}; }
  & > dd { margin: 0; font-weight: 600; }
`

const PlayTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;
  text-align: center;

  th, td { padding: 4px; border-bottom: 1px solid ${({ theme }) => theme.colors.border}; }
  th { color: ${({ theme }) => theme.colors.textMuted}; font-weight: 600; }
  td[data-lead] { text-decoration: underline; }
  td[data-win] { font-weight: 800; background: ${({ theme }) => theme.colors.primarySoft}; }
`

const Section = styled.h2`
  margin: 16px 0 8px;
  font-size: 16px;
`

const Links = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
`

export function BoardPage() {
  const { recordId } = useParams()
  const { t, message } = usePreferences()
  const [record, setRecord] = useState<BoardRecord | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!recordId) return
    api
      .record(recordId)
      .then(({ record }) => setRecord(record))
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [recordId, message])

  if (error)
    return (
      <PageMain>
        <ErrorText role="alert">{error}</ErrorText>
        <p>
          <Link to="/history">{t.backToHistory}</Link>
        </p>
      </PageMain>
    )
  if (!record) return <PageMain>{t.loading}</PageMain>
  return <BoardRecordView record={record} />
}

function BoardRecordView({ record }: { record: BoardRecord }) {
  const { t, lang, cardStyle } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const { board, players } = record
  const total = board.play.length
  const [step, setStep] = useState(0)
  const [copied, setCopied] = useState(false)

  const shown = { ...board, play: board.play.slice(0, step) }
  const current = tricksOf(shown).at(-1)
  const allTricks = tricksOf(board)
  const contract = board.contract
  const result = board.result!
  const name = (u: PublicUser) => (u.robot ? t.robot : u.username)
  const width = phone ? 34 : 54

  const go = (n: number) => setStep(Math.max(0, Math.min(total, n)))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setStep((s) => Math.min(total, s + 1))
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [total])

  const copyLin = async () => {
    try {
      await navigator.clipboard.writeText(toLin(record))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the Handviewer link still works
    }
  }

  return (
    <PageMain>
      <PageTitle>
        {t.tableName(record.tableNumber)} · {t.boardNo(board.boardNo)}
      </PageTitle>
      <Columns>
        <div>
          <Diagram>
            <Spot $area="info">
              <BoardInfo boardNo={board.boardNo} dealer={board.dealer} vul={board.vul} positions={POSITIONS} />
            </Spot>
            {SEATS.map((seat) => (
              <Spot key={seat} $area={positionOf(seat)}>
                <Name>
                  {seatLetter[seat]} {name(players[seat])} · {t.hcp(hcp(board.hands[seat]))}
                </Name>
                <HandView
                  cards={step === 0 ? board.hands[seat] : remainingCards(shown, seat)}
                  count={13}
                  width={width}
                  style={phone && (seat === 'E' || seat === 'W') ? 'text' : cardStyle}
                  label={`${seatLetter[seat]} ${name(players[seat])}`}
                />
              </Spot>
            ))}
            <Spot $area="center">
              {current && step > 0 ? (
                <TrickArea cards={current.cards} positionOf={positionOf} winner={current.winner} width={width} label={t.thisTrick} />
              ) : (
                <TrickSpace $w={width} />
              )}
            </Spot>
          </Diagram>
          {total > 0 && (
            <Controls role="group" aria-label={t.replay}>
              <Button type="button" $small onClick={() => go(0)} aria-label={t.start}>
                <ChevronFirst size={18} aria-hidden />
              </Button>
              <Button type="button" $small onClick={() => go(step - 1)} aria-label={t.prev}>
                <ChevronLeft size={18} aria-hidden />
              </Button>
              <Muted>
                {step}/{total}
              </Muted>
              <Button type="button" $small onClick={() => go(step + 1)} aria-label={t.next}>
                <ChevronRight size={18} aria-hidden />
              </Button>
              <Button type="button" $small onClick={() => go(total)} aria-label={t.end}>
                <ChevronLast size={18} aria-hidden />
              </Button>
            </Controls>
          )}
        </div>
        <Card>
          <Meta>
            <dt>{t.date}</dt>
            <dd>{formatDateTime(record.finishedAt, lang)}</dd>
            <dt>{t.contract}</dt>
            <dd>
              <ContractLabel contract={contract} />
            </dd>
            {contract && (
              <>
                <dt>{t.declarer}</dt>
                <dd>{name(players[contract.declarer])}</dd>
                <dt>{t.result}</dt>
                <dd>
                  {result.declarerTricks} {t.tricks}（{resultLabel(contract, result.declarerTricks)}）
                  {result.claimed && t.claimed}
                </dd>
              </>
            )}
            <dt>{t.scoreNS}</dt>
            <dd>{signed(result.scoreNS)}</dd>
          </Meta>
          <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} />
          <Links>
            <Button as="a" href={handviewerUrl(record)} target="_blank" rel="noopener" $small>
              <ExternalLink size={16} aria-hidden />
              {t.openHandviewer}
            </Button>
            <Button type="button" $small onClick={copyLin}>
              {copied ? t.copiedLin : t.copyLin}
            </Button>
          </Links>
        </Card>
      </Columns>

      {allTricks.length > 0 && (
        <>
          <Section>{t.playRecord}</Section>
          <Card>
            <PlayTable>
              <thead>
                <tr>
                  <th>#</th>
                  {SEATS.map((seat) => (
                    <th key={seat}>{seatLetter[seat]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allTricks.map((trick, i) => (
                  <tr key={i} onClick={() => go(i * 4 + trick.cards.length)} style={{ cursor: 'pointer' }}>
                    <td>{i + 1}</td>
                    {SEATS.map((seat) => {
                      const played = trick.cards.find((c) => c.seat === seat)
                      return (
                        <td
                          key={seat}
                          data-lead={trick.leader === seat ? '' : undefined}
                          data-win={trick.winner === seat ? '' : undefined}
                          aria-label={played ? cardName(played.card, t) : undefined}
                        >
                          {played && (
                            <>
                              <SuitSymbol suit={suitOf(played.card)} />
                              {rankLabel(rankOf(played.card))}
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </PlayTable>
          </Card>
        </>
      )}
      <p>
        <Link to="/history">{t.backToHistory}</Link>
      </p>
    </PageMain>
  )
}
