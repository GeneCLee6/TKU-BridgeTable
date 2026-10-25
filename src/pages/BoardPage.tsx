import { ExternalLink, Swords } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { rankLabel, rankOf, SEATS, suitOf } from '../../shared/cards.ts'
import { tricksOf } from '../../shared/game.ts'
import { handviewerUrl, toLin } from '../../shared/lin.ts'
import type { BoardRecord, PublicUser } from '../../shared/protocol.ts'
import type { Traveller } from '../../shared/traveller.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { ChallengeDialog } from '../components/ChallengeDialog.tsx'
import { DoubleDummyPanel } from '../components/DoubleDummyPanel.tsx'
import { FavoriteButton } from '../components/FavoriteButton.tsx'
import { RecordDiagram } from '../components/RecordDiagram.tsx'
import { ReplayControls } from '../components/ReplayControls.tsx'
import { ContractLabel, ContractResult, SuitSymbol } from '../components/Suit.tsx'
import { TravellerTable } from '../components/Traveller.tsx'
import { Button, Card, ErrorText, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { CARD_SCALE, cardName } from '../lib/cards.ts'
import { challengeRobotsOf } from '../lib/challenges.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { canAnalyse } from '../lib/useDoubleDummy.ts'
import { useTrickReplay } from '../lib/useTrickReplay.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobileQuery } from '../styles/tokens.ts'
import { playerName, seatLetter } from '../strings.ts'

/**
 * One finished board: the deal as a hand diagram (RecordDiagram, BBO's Handviewer), the auction,
 * and a trick-by-trick replay like BBO's movie (each step plays the four cards of a trick one after
 * another). North is always at the top here, as in a printed hand record.
 */

/** The diagram uses the full width so the hands can be large; the details follow below */
const Columns = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  max-width: 1000px;
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
  const [loaded, setLoaded] = useState<{ boardId: string; traveller: Traveller | null } | null>(null)
  const { user } = useAuth()

  useEffect(() => {
    if (!recordId) return
    api
      .record(recordId)
      .then(({ record }) => setRecord(record))
      .catch((e) => setError(message(e.code, e.params, e.message)))
  }, [recordId, message])

  // A challenge board's traveller, when the server lets this member see it (e4-t32)
  const eventBoard = record?.id === recordId && !!record?.eventId
  const traveller = loaded && loaded.boardId === recordId ? loaded.traveller : null
  useEffect(() => {
    if (!recordId || !eventBoard) return
    let live = true
    api
      .traveller(recordId)
      .then((r) => live && setLoaded({ boardId: recordId, traveller: r.traveller }))
      .catch(() => {
        // Without a traveller the record is still worth reading
      })
    return () => {
      live = false
    }
  }, [recordId, eventBoard])

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
  const own = traveller?.entries.find((e) => e.userId === user?.id)?.boardId
  return (
    <BoardRecordView
      key={record.id}
      record={record}
      after={
        traveller && (
          <>
            <Section>{t.travellerTitle}</Section>
            <Card>
              <TravellerTable traveller={traveller} current={record.id} compareFrom={own ?? record.id} viewerId={user?.id} />
            </Card>
          </>
        )
      }
    />
  )
}

/**
 * One board's record; `embedded` drops the page frame for the table's history dialog, `after`
 * goes below the diagram and the details (the traveller)
 */
export function BoardRecordView({
  record,
  embedded = false,
  after,
}: {
  record: BoardRecord
  embedded?: boolean
  after?: ReactNode
}) {
  const { t, lang, cardStyle, cardSize } = usePreferences()
  const scale = CARD_SCALE[cardSize]
  const phone = useMediaQuery(mobileQuery)
  const { board, players } = record
  const total = board.play.length
  const replay = useTrickReplay(total)
  const { step } = replay
  const [copied, setCopied] = useState(false)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [challenging, setChallenging] = useState(false)
  const [openedAt] = useState(() => Date.now())
  // 「用這副牌挑戰」 (`e7-t22`): only a board the viewer played with three robots
  const robots = !embedded && user ? challengeRobotsOf(record, user.id, openedAt) : null

  const allTricks = tricksOf(board)
  const contract = board.contract
  const result = board.result!
  const name = (u: PublicUser) => playerName(t, u)
  // North and South fan out across the full width; East and West go in rows by suit beside the trick
  const width = Math.round((phone ? 40 : 72) * scale)
  const side = (seat: string) => seat === 'E' || seat === 'W'

  const copyLin = async () => {
    try {
      await navigator.clipboard.writeText(toLin(record))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the Handviewer link still works
    }
  }

  const Frame = embedded ? EmbeddedFrame : PageMain
  return (
    <Frame>
      <PageTitle>
        {record.mode === 'challenge' ? t.challenge : t.tableName(record.tableNumber)} · {t.boardNo(board.boardNo)}
      </PageTitle>
      <Columns>
        <div>
          <RecordDiagram
            record={record}
            step={step}
            width={width}
            trickWidth={Math.round((phone ? 34 : 58) * scale)}
            styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
            orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
          />
          {total > 0 && <ReplayControls replay={replay} total={total} />}
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
                  <ContractResult contract={contract} tricks={result.declarerTricks} />
                  {result.claimed && t.claimed}
                </dd>
              </>
            )}
            <dt>{t.scoreNS}</dt>
            <dd>NS {signed(result.scoreNS)}</dd>
          </Meta>
          <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} />
          <Links>
            <FavoriteButton boardId={record.id} />
            <Button as="a" href={handviewerUrl(record)} target="_blank" rel="noopener" $small>
              <ExternalLink size={16} aria-hidden />
              {t.openHandviewer}
            </Button>
            <Button type="button" $small onClick={copyLin}>
              {copied ? t.copiedLin : t.copyLin}
            </Button>
            {robots && (
              <Button type="button" $small onClick={() => setChallenging(true)}>
                <Swords size={16} aria-hidden />
                {t.challengeWithBoard}
              </Button>
            )}
          </Links>
        </Card>
      </Columns>
      {after}

      {canAnalyse(board) && (
        <>
          <Section>{t.ddTitle}</Section>
          <Card>
            <DoubleDummyPanel board={board} />
          </Card>
        </>
      )}

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
                  <tr key={i} onClick={() => replay.jump(i * 4 + trick.cards.length)} style={{ cursor: 'pointer' }}>
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
      {!embedded && (
        <p>
          <Link to="/history">{t.backToHistory}</Link>
        </p>
      )}
      {challenging && robots && (
        <ChallengeDialog
          fromBoards={{ ids: [record.id], robotKind: robots }}
          onClose={() => setChallenging(false)}
          onCreated={(c) => navigate(`/challenges/${c.id}`)}
        />
      )}
    </Frame>
  )
}

const EmbeddedFrame = styled.div``
