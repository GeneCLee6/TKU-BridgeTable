import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { ROOMS, VUGRAPH_CHAT_MAX, type MatchVugraph, type Room, type VugraphRoom } from '../../shared/team-match.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { ScoreLine } from '../components/MatchParts.tsx'
import { RecordDiagram } from '../components/RecordDiagram.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { ActionLink, Button, Card, ErrorText, Input, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { CARD_SCALE } from '../lib/cards.ts'
import { teamName } from '../lib/matches.ts'
import { useMediaQuery } from '../lib/useMediaQuery.ts'
import { VUGRAPH_POLL_MS, vugraphRecord } from '../lib/vugraph.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { mobile, mobileQuery } from '../styles/tokens.ts'

/**
 * The Vugraph page of a team match (`e8-t18`, `e8-t19`, AC-8.8, ARCHITECTURE.md §5.8): both rooms
 * side by side as a watcher sees them, the live score, and the watchers' chat. The server decides
 * everything shown: a player of the match never gets the page while it is on, and when the match
 * plays one trick behind the cards since never reach this browser. Asked for again every few
 * seconds while the match is played
 */

const Back = styled(ActionLink)`
  margin: 0 0 8px -4px;
`

const Head = styled.div`
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
`

const Rooms = styled.div`
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
  gap: 10px;
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

const Chat = styled(Card)`
  display: grid;
  gap: 8px;
  max-width: 1200px;
  margin-top: 16px;

  & > h2 {
    margin: 0;
    font-size: 17px;
  }
`

const Lines = styled.ol`
  display: grid;
  gap: 4px;
  max-height: 240px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;

  & strong {
    margin-right: 6px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Say = styled.form`
  display: flex;
  gap: 8px;
`

export function VugraphPage() {
  const { matchId = '' } = useParams()
  const { t, message } = usePreferences()
  const [page, setPage] = useState<MatchVugraph | null>(null)
  const [error, setError] = useState('')

  // Again every few seconds while the match is played; not while the tab is hidden
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(load, VUGRAPH_POLL_MS)
        return
      }
      api
        .matchVugraph(matchId)
        .then(({ vugraph }) => {
          if (!live) return
          setPage(vugraph)
          setError('')
          if (vugraph.match.status === 'playing') timer = setTimeout(load, VUGRAPH_POLL_MS)
        })
        .catch((e) => live && setError(message(e.code, e.params, e.message)))
    }
    load()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [matchId, message])

  const back = (
    <Back back to={`/matches/${encodeURIComponent(matchId)}`}>
      {t.teamMatch.title}
    </Back>
  )
  if (error && !page)
    return (
      <PageMain>
        {back}
        <ErrorText role="alert">{error}</ErrorText>
      </PageMain>
    )
  if (!page) return <PageMain>{t.loading}</PageMain>
  const m = page.match
  const playing = m.status === 'playing'
  return (
    <PageMain>
      {back}
      <PageTitle>
        {t.teamMatch.vugraph} · {t.teamMatch.vs(teamName(t, m, 'A'), teamName(t, m, 'B'))}
      </PageTitle>
      <Head>
        <ScoreLine match={m} />
        <Muted>{t.teamMatch.vugraphNote}</Muted>
        {playing && m.settings.delay && <Muted>{t.teamMatch.vugraphDelayed}</Muted>}
        {playing && m.pausedAt !== undefined && <Muted role="status">{t.teamMatch.pausedHint}</Muted>}
        {!playing && (
          <Muted>
            {t.teamMatch.vugraphEnded}{' '}
            {m.boards.some((b) => b.open && b.closed) && <Link to={`/matches/${encodeURIComponent(m.id)}/replay`}>{t.teamMatch.replayAll}</Link>}
          </Muted>
        )}
        {error && <ErrorText role="alert">{error}</ErrorText>}
      </Head>
      {playing && (
        <Rooms>
          {ROOMS.map((room) => (
            <RoomSide key={room} room={room} view={page.rooms[room]} />
          ))}
        </Rooms>
      )}
      <ChatBox matchId={m.id} page={page} playing={playing} onPage={setPage} />
    </PageMain>
  )
}

function RoomSide({ room, view }: { room: Room; view: VugraphRoom | undefined }) {
  const { t, cardStyle, cardSize } = usePreferences()
  const phone = useMediaQuery(mobileQuery)
  const scale = CARD_SCALE[cardSize]
  const record = view ? vugraphRecord(view) : null
  const side = (seat: string) => seat === 'E' || seat === 'W'
  const name = t.teamMatch.rooms[room]
  const board = view?.board
  return (
    <Side aria-label={name}>
      <h2>{view && view.match.seq > 0 ? t.teamMatch.roomBoard(name, view.match.seq, view.match.boards) : name}</h2>
      {view?.match.over && <Muted>{t.teamMatch.waitingOther}</Muted>}
      {!record || !board ? (
        <Muted>{t.teamMatch.vugraphNotDealt}</Muted>
      ) : (
        <>
          {board.contract && (
            <Line>
              <ContractLabel contract={board.contract} /> · {t.teamMatch.tricksLine(board.tricksWon.NS, board.tricksWon.EW)}
            </Line>
          )}
          <RecordDiagram
            record={record}
            step={record.board.play.length}
            width={Math.round(40 * scale)}
            trickWidth={Math.round((phone ? 34 : 38) * scale)}
            styleFor={(seat) => (phone && side(seat) ? 'text' : cardStyle)}
            orientationFor={(seat) => (side(seat) && !phone ? 'rows' : 'horizontal')}
          />
          <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} size={40} />
        </>
      )}
    </Side>
  )
}

/** The watchers' chat: only watchers get it, the server keeps it from the players */
function ChatBox({
  matchId,
  page,
  playing,
  onPage,
}: {
  matchId: string
  page: MatchVugraph
  playing: boolean
  onPage: (page: MatchVugraph) => void
}) {
  const { t, message } = usePreferences()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const say = async (e: FormEvent) => {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    try {
      const { vugraph } = await api.matchVugraphChat(matchId, text)
      onPage(vugraph)
      setText('')
      setError('')
    } catch (err) {
      setError(err instanceof ApiError ? message(err.code, err.params, err.message) : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Chat aria-labelledby="vugraph-chat">
      <h2 id="vugraph-chat">{t.teamMatch.vugraphChat}</h2>
      <Muted>{t.teamMatch.vugraphChatHint}</Muted>
      {page.chat.length === 0 ? (
        <Muted>{t.teamMatch.vugraphChatEmpty}</Muted>
      ) : (
        <Lines>
          {page.chat.map((line) => (
            <li key={line.id}>
              <strong>{line.username}</strong>
              {line.text}
            </li>
          ))}
        </Lines>
      )}
      {playing && (
        <Say onSubmit={(e) => void say(e)}>
          <Input
            aria-label={t.teamMatch.vugraphSay}
            placeholder={t.teamMatch.vugraphSay}
            value={text}
            maxLength={VUGRAPH_CHAT_MAX}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" $variant="primary" disabled={busy || !text.trim()}>
            {t.teamMatch.vugraphSend}
          </Button>
        </Say>
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Chat>
  )
}
