import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { SEATS } from '../../shared/cards.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { DdReplayBar } from '../components/DoubleDummyReplay.tsx'
import { RecordDiagram } from '../components/RecordDiagram.tsx'
import { ReplayControls } from '../components/ReplayControls.tsx'
import { ContractResult } from '../components/Suit.tsx'
import { ActionLink, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { CARD_SCALE } from '../lib/cards.ts'
import { signed } from '../lib/format.ts'
import { canAnalyse } from '../lib/useDoubleDummy.ts'
import { useDoubleDummyReplay } from '../lib/useDoubleDummyReplay.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { useTrickReplay } from '../lib/useTrickReplay.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile, mobileQuery } from '../styles/tokens.ts'
import { playerName } from '../strings.ts'

/**
 * Side-by-side replay (`e4-t33`, AC-4.12): two results of the same board, played trick by trick
 * together with one set of controls, as in BBO's traveller "compare". Challenges use it now ("和他
 * 並排看", `e7-t19`); team matches and pairs later. Each record comes from `/api/history/:id`, so
 * the server decides whether the member may see it (§4).
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Pair = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  max-width: 1200px;

  ${mobile} {
    grid-template-columns: minmax(0, 1fr);
  }
`

const Side = styled(Card)`
  display: grid;
  gap: 12px;
  align-content: start;

  & > h2 {
    margin: 0;
    font-size: 17px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Line = styled.p`
  margin: 0;
  font-weight: 600;
`

const Head = styled.div`
  margin-bottom: 12px;
`

/** The member whose result a record is: the first person at the table (a challenge has one) */
const playerOf = (record: BoardRecord) =>
  SEATS.map((seat) => record.players[seat]).find((p) => p.id && !p.robot) ?? record.players.S

export function ComparePage() {
  const { recordId = '', otherId = '' } = useParams()
  const { t, message } = usePreferences()
  const pair = `${recordId}/${otherId}`
  const [loaded, setLoaded] = useState<{ pair: string; records: [BoardRecord, BoardRecord] } | null>(null)
  const records = loaded?.pair === pair ? loaded.records : null
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    Promise.all([api.record(recordId), api.record(otherId)])
      .then(([a, b]) => live && setLoaded({ pair: `${recordId}/${otherId}`, records: [a.record, b.record] }))
      .catch((e) => live && setError(message(e.code, e.params, e.message)))
    return () => {
      live = false
    }
  }, [recordId, otherId, message])

  const back = (
    <Back back to={`/history/${recordId}`}>
      {t.openBoard}
    </Back>
  )
  if (error)
    return (
      <PageMain>
        {back}
        <ErrorText role="alert">{error}</ErrorText>
      </PageMain>
    )
  if (!records) return <PageMain>{t.loading}</PageMain>
  return (
    <PageMain>
      {back}
      <SideBySide key={pair} records={records} />
    </PageMain>
  )
}

function SideBySide({ records }: { records: [BoardRecord, BoardRecord] }) {
  const { t } = usePreferences()
  // One replay for both: each side shows as many of its own cards as it has (a claim ends early)
  const total = Math.max(...records.map((r) => r.board.play.length))
  const replay = useTrickReplay(total)
  // One double-dummy switch for both; each side tries out its own cards
  const analysable = records.some((r) => canAnalyse(r.board) && !!r.board.contract)
  const [ddOn, setDdOn] = useState(false)

  return (
    <>
      <PageTitle>
        {t.compareTitle} · {t.boardNo(records[0].board.boardNo)}
      </PageTitle>
      <Head>
        <Muted>{t.compareNote}</Muted>
        {total > 0 && <ReplayControls replay={replay} total={total} dd={analysable ? { on: ddOn, onChange: setDdOn } : undefined} />}
      </Head>
      <Pair>
        {records.map((record, i) => (
          <CompareSide key={i} record={record} step={Math.min(replay.step, record.board.play.length)} playing={replay.playing} ddOn={ddOn} />
        ))}
      </Pair>
    </>
  )
}

function CompareSide({ record, step, playing, ddOn }: { record: BoardRecord; step: number; playing: boolean; ddOn: boolean }) {
  const { t, cardStyle, cardSize } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const scale = CARD_SCALE[cardSize]
  const width = Math.round((phone ? 40 : 44) * scale)
  const side = (seat: string) => seat === 'E' || seat === 'W'
  const { board } = record
  const result = board.result!
  const dd = useDoubleDummyReplay(board, step, ddOn && canAnalyse(board) && !!board.contract, playing)

  return (
    <Side aria-label={playerName(t, playerOf(record))}>
      <h2>{playerName(t, playerOf(record))}</h2>
      <Line>
        <ContractResult contract={board.contract} tricks={result.declarerTricks} />
        {result.claimed && t.claimed} · NS {signed(result.scoreNS)}
      </Line>
      <div>
        <RecordDiagram
          record={record}
          step={step}
          width={width}
          trickWidth={Math.round((phone ? 34 : 40) * scale)}
          styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
          orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
          dd={dd}
        />
        <DdReplayBar dd={dd} />
      </div>
      <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} size={44} />
      <Link to={`/history/${record.id}`}>{t.openBoard}</Link>
    </Side>
  )
}
