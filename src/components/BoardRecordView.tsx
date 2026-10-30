import { ExternalLink, Swords } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import styled, { css } from 'styled-components'
import { actionTimes, realGaps } from '../../shared/board-events.ts'
import { rankLabel, rankOf, SEATS, suitOf } from '../../shared/cards.ts'
import { tricksOf } from '../../shared/game.ts'
import { handviewerUrl, toLin } from '../../shared/lin.ts'
import { robotKindsFor, type BoardRecord, type PublicUser } from '../../shared/protocol.ts'
import { CARD_SCALE, cardName } from '../lib/cards.ts'
import { challengeRobotsOf } from '../lib/challenges.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { canAnalyse } from '../lib/useDoubleDummy.ts'
import { useDoubleDummyReplay } from '../lib/useDoubleDummyReplay.ts'
import { rulingLabel } from '../lib/rulings.ts'
import { REPLAY_CARD_MS, useTrickReplay } from '../lib/useTrickReplay.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobileQuery } from '../styles/tokens.ts'
import { boardPlace, playerName, seatLetter } from '../strings.ts'
import { AuctionBox } from './AuctionBox.tsx'
import { ChallengeDialog } from './ChallengeDialog.tsx'
import { DoubleDummyPanel } from './DoubleDummyPanel.tsx'
import { DdReplayBar } from './DoubleDummyReplay.tsx'
import { FavoriteButton } from './FavoriteButton.tsx'
import { FeaturedPanel } from './FeaturedPanel.tsx'
import { RecordDiagram } from './RecordDiagram.tsx'
import { RecordSubstitutes } from './RecordSubstitutes.tsx'
import { ReplayControls } from './ReplayControls.tsx'
import { RulingPanel } from './RulingPanel.tsx'
import { ContractLabel, ContractResult, SuitSymbol } from './Suit.tsx'
import { Button, Card, PageMain, PageTitle } from './ui.tsx'

/**
 * One finished board's record: the deal as a hand diagram (RecordDiagram, BBO's Handviewer), the
 * auction, and a trick-by-trick replay like BBO's movie (each step plays the four cards of a trick
 * one after another), with 雙夢家模式, the double-dummy table and the play record. North is always
 * at the top, as in a printed hand record. The record page (`BoardPage`), a challenge board's page
 * and the side panel's 紀錄 all show a board with this, so they have the same features
 * (社長 2026-10-27); the side panel's is `compact`.
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

  & > dt {
    color: ${({ theme }) => theme.colors.textMuted};
  }
  & > dd {
    margin: 0;
    font-weight: 600;
  }
`

const PlayTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 15px;
  text-align: center;

  th,
  td {
    padding: 4px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
  }
  td[data-lead] {
    text-decoration: underline;
  }
  td[data-win] {
    font-weight: 800;
    background: ${({ theme }) => theme.colors.primarySoft};
  }
`

/** A heading between the parts of a record (also the traveller's, on the record page) */
export const RecordSection = styled.h2`
  margin: 16px 0 8px;
  font-size: 16px;
`

const Links = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
`

/** In the side panel the cards are as narrow as the panel, a little less padding */
const Part = styled(Card)<{ $compact: boolean }>`
  ${({ $compact }) =>
    $compact &&
    css`
      --card-pad: 12px;
    `}
`

const EmbeddedFrame = styled.div``

/** Links that would leave the table page open in a new tab there, since leaving the page leaves the table */
const NEW_TAB = { target: '_blank', rel: 'noopener' } as const

/**
 * One board's record; `embedded` drops the page frame (a challenge board's page), `titled` false
 * drops the title (the page has its own), `after` goes below the diagram and the details (the
 * traveller). `compact` is the side panel's: embedded, text cards sized for the panel, the arrow
 * keys left to the table, and a link to the full page (in a new tab with `newTab`, at a table).
 */
export function BoardRecordView({
  record,
  embedded = false,
  titled = true,
  compact = false,
  newTab = false,
  after,
}: {
  record: BoardRecord
  embedded?: boolean
  titled?: boolean
  compact?: boolean
  newTab?: boolean
  after?: ReactNode
}) {
  const { t, lang, cardStyle, cardSize } = usePreferences()
  const scale = CARD_SCALE[cardSize]
  const phone = useMediaQuery(mobileQuery)
  const framed = !embedded && !compact
  const { board, players } = record
  const total = board.play.length
  // 照實際速度 (`e2-t33`): the cards come out as far apart as they were played, from the action log
  const times = useMemo(() => actionTimes(record.events, board.auction.length, total), [record.events, board.auction.length, total])
  const gaps = useMemo(() => times && realGaps(times, record.startedAt), [times, record.startedAt])
  const [realSpeed, setRealSpeed] = useState(false)
  const replay = useTrickReplay(total, REPLAY_CARD_MS, realSpeed && gaps ? gaps : undefined)
  // A ruling given or taken back on this page (`e2-t35`) shows at once
  const [ruling, setRuling] = useState(record.ruling)
  const ruled = ruling === record.ruling ? record : { ...record, ruling }
  const { step } = replay
  const [copied, setCopied] = useState(false)
  const { user } = useAuth()
  const navigate = useNavigate()
  const [challenging, setChallenging] = useState(false)
  const [openedAt] = useState(() => Date.now())
  // Double-dummy mode in the replay (BBO's "DD"): only a finished board with a contract
  const analysable = canAnalyse(board) && !!board.contract
  const [ddOn, setDdOn] = useState(false)
  const dd = useDoubleDummyReplay(board, step, analysable && ddOn, replay.playing)
  // 「用這副牌挑戰」 (`e7-t22`): only a board the viewer played with three robots, of a system they
  // may set up (the club's needs `tkuSystem`, ROBOT.md §7)
  const played = framed && user ? challengeRobotsOf(record, user.id, openedAt) : null
  const robots = played && robotKindsFor(user).includes(played) ? played : null

  const allTricks = tricksOf(board)
  const contract = board.contract
  const result = board.result!
  const name = (u: PublicUser) => playerName(t, u)
  // North and South fan out across the full width; East and West go in rows by suit beside the trick
  const width = compact ? 48 : Math.round((phone ? 40 : 72) * scale)
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

  const Frame = framed ? PageMain : EmbeddedFrame
  return (
    <Frame>
      {titled && !compact && (
        <PageTitle>
          {boardPlace(t, record)} · {t.boardNo(board.boardNo)}
        </PageTitle>
      )}
      <Columns>
        <div>
          {compact ? (
            <RecordDiagram
              record={record}
              step={step}
              width={width}
              trickWidth={30}
              styleFor={() => 'text'}
              compact
              dd={dd}
            />
          ) : (
            <RecordDiagram
              record={record}
              step={step}
              width={width}
              trickWidth={Math.round((phone ? 34 : 58) * scale)}
              styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
              orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
              dd={dd}
            />
          )}
          {total > 0 && (
            <ReplayControls
              replay={replay}
              total={total}
              keys={!compact}
              dd={analysable ? { on: ddOn, onChange: setDdOn } : undefined}
              real={
                times && gaps
                  ? { on: realSpeed, onChange: setRealSpeed, elapsed: replay.step > 0 ? times.cards[replay.step - 1] - (record.startedAt ?? times.cards[0]) : 0 }
                  : undefined
              }
            />
          )}
          <DdReplayBar dd={dd} />
        </div>
        <Part $compact={compact}>
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
            {compact && ruling && (
              <>
                <dt>{t.director.ruling}</dt>
                <dd>{rulingLabel(t, ruling)}</dd>
              </>
            )}
            <RecordSubstitutes record={record} />
          </Meta>
          {!compact && <RulingPanel record={ruled} onRuled={setRuling} />}
          <AuctionBox
            auction={board.auction}
            dealer={board.dealer}
            vul={board.vul}
            size={compact ? 44 : undefined}
          />
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
            {compact && (
              <Link to={`/history/${record.id}`} {...(newTab ? NEW_TAB : {})}>
                {t.openFullPage}
              </Link>
            )}
          </Links>
        </Part>
      </Columns>
      {framed && (
        <FeaturedPanel
          record={record}
          trick={replay.trick}
          onTrick={(n) => replay.jump(Math.min(total, n * 4))}
        />
      )}
      {after}

      {canAnalyse(board) && (
        <>
          <RecordSection>{t.ddTitle}</RecordSection>
          <Part $compact={compact}>
            <DoubleDummyPanel board={board} />
          </Part>
        </>
      )}

      {allTricks.length > 0 && (
        <>
          <RecordSection>{t.playRecord}</RecordSection>
          <Part $compact={compact}>
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
                  <tr
                    key={i}
                    onClick={() => replay.jump(i * 4 + trick.cards.length)}
                    style={{ cursor: 'pointer' }}
                  >
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
          </Part>
        </>
      )}
      {framed && (
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
