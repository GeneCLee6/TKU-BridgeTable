import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { SEATS } from '../../shared/cards.ts'
import type { BoardRecord, SharedBoard } from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { DoubleDummyPanel } from '../components/DoubleDummyPanel.tsx'
import { RecordDiagram } from '../components/RecordDiagram.tsx'
import { ReplayControls } from '../components/ReplayControls.tsx'
import { ContractLabel, ContractResult } from '../components/Suit.tsx'
import { Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { homePath } from '../lib/club.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { canAnalyse } from '../lib/useDoubleDummy.ts'
import { REPLAY_CARD_MS, useTrickReplay } from '../lib/useTrickReplay.ts'
import { useSignedIn } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName, type Strings } from '../strings.ts'
import { mobileQuery } from '../styles/tokens.ts'

/**
 * A board opened by its public link (`/share/<token>`, e4-t38), signed in or not: the deal, the
 * auction, a trick-by-trick replay, the result and the double-dummy table, nothing else. The
 * server sends only what `sharedBoardView` (worker/views.ts) lets out; a seat whose member keeps
 * their boards private comes without a name and shows as 「社員」
 */

const Section = styled.h2`
  margin: 16px 0 8px;
  font-size: 16px;
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

const Layout = styled.div`
  display: grid;
  gap: 16px;
  max-width: 1000px;
`

/** The shared board in the shape the record's parts take; no ids, so nothing links anywhere */
function sharedRecord(shared: SharedBoard, t: Strings): BoardRecord {
  const players = {} as BoardRecord['players']
  for (const seat of SEATS) {
    const p = shared.players[seat]
    players[seat] = {
      id: '',
      username: p.name ?? t.recordExport.hiddenPlayer,
      ...(p.robot && { robot: true }),
      ...(p.robotKind && { robotKind: p.robotKind }),
    }
  }
  return { id: '', tableNumber: 0, finishedAt: shared.finishedAt, players, board: shared.board }
}

export function SharedBoardPage() {
  const { token = '' } = useParams()
  const { t, message } = usePreferences()
  const signedIn = useSignedIn()
  const [shared, setShared] = useState<SharedBoard | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    api
      .sharedBoard(token)
      .then((r) => live && setShared(r.shared))
      .catch((e) => live && setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError))
    return () => {
      live = false
    }
  }, [token, message, t.genericError])

  if (error)
    return (
      <PageMain>
        <ErrorText role="alert">{error}</ErrorText>
        <p>
          <Link to={homePath(signedIn)}>{t.recordExport.sharedHome}</Link>
        </p>
      </PageMain>
    )
  if (!shared) return <PageMain>{t.loading}</PageMain>
  return <SharedBoardView shared={shared} />
}

function SharedBoardView({ shared }: { shared: SharedBoard }) {
  const { t, lang, cardStyle } = usePreferences()
  const signedIn = useSignedIn()
  const phone = useMediaQuery(mobileQuery)
  const record = useMemo(() => sharedRecord(shared, t), [shared, t])
  const { board } = record
  const total = board.play.length
  const replay = useTrickReplay(total, REPLAY_CARD_MS)
  const contract = board.contract
  const result = board.result!
  const side = (seat: string) => seat === 'E' || seat === 'W'
  return (
    <PageMain>
      <PageTitle>{t.boardNo(board.boardNo)}</PageTitle>
      <Muted>{t.recordExport.sharedNote}</Muted>
      <Layout>
        <div>
          <RecordDiagram
            record={record}
            step={replay.step}
            width={phone ? 40 : 72}
            trickWidth={phone ? 34 : 58}
            styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
            orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
          />
          {total > 0 && <ReplayControls replay={replay} total={total} keys />}
        </div>
        <Card>
          <Meta>
            <dt>{t.date}</dt>
            <dd>{formatDateTime(shared.finishedAt, lang)}</dd>
            <dt>{t.contract}</dt>
            <dd>
              <ContractLabel contract={contract} />
            </dd>
            {contract && (
              <>
                <dt>{t.declarer}</dt>
                <dd>{playerName(t, record.players[contract.declarer])}</dd>
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
        </Card>
      </Layout>
      {canAnalyse(board) && (
        <>
          <Section>{t.ddTitle}</Section>
          <Card>
            <DoubleDummyPanel board={board} />
          </Card>
        </>
      )}
      <p>
        <Link to={homePath(signedIn)}>{t.recordExport.sharedHome}</Link>
      </p>
    </PageMain>
  )
}
