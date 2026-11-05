import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { DEAL_PRESET_IDS } from '../../shared/deal-presets.ts'
import {
  PARTNER_BID_ACTIVE_MAX,
  PARTNER_BID_BOARDS_MAX,
  PARTNER_BID_IDLE_MS,
  PARTNER_BID_INVITE_MS,
  PARTNER_BID_KEEP_MS,
  type PartnerBidBoardView,
  type PartnerBidDeal,
  type PartnerBidSummary,
  type PartnerBidView,
} from '../../shared/partner-bidding.ts'
import type { PracticeSetInfo } from '../../shared/practice-sets/types.ts'
import { isRobotId, robotKindsFor, type RobotKind } from '../../shared/protocol.ts'
import { AuctionBox } from '../components/AuctionBox.tsx'
import { BiddingBox } from '../components/BiddingBox.tsx'
import { HandView } from '../components/HandView.tsx'
import { PracticeReviewBody } from '../components/PracticeReview.tsx'
import { ContractLabel } from '../components/Suit.tsx'
import { Button, Card, ErrorText, Field, FieldLabel, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 搭檔非同步叫牌練習 (`e10-t08`, AC-10.6, ARCHITECTURE.md §5.11): the member's sessions and a form to
 * invite a partner (`/partner-bidding`), one session with the board being bid and the boards done
 * (`/partner-bidding/:sessionId`), and a board's review (`/partner-bidding/:sessionId/boards/:seq`).
 * The pages only show: what each member may see and call comes from the server (`partnerBidView`).
 */

const DAY_MS = 24 * 60 * 60 * 1000

const Form = styled.form`
  display: grid;
  gap: 12px;
  max-width: 420px;
`

const Sessions = styled.ul`
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
`

const SessionRow = styled.li`
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 10px 12px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.sm};
`

const TurnTag = styled.strong`
  color: ${({ theme }) => theme.colors.accent};
`

const Spaced = styled.div`
  display: grid;
  gap: 16px;
  margin-top: 16px;
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
`

/** The table's colours behind the hand and the auction box, as at a table */
const Felt = styled.div`
  display: grid;
  justify-items: center;
  gap: 12px;
  padding: 16px 8px;
  border-radius: ${({ theme }) => theme.radius.md};
  background: ${({ theme }) => theme.table.felt};
  color: ${({ theme }) => theme.table.feltText};
`

const namesOf = (session: PartnerBidSummary): Partial<Record<Seat, string>> => ({ S: session.inviter.username, N: session.partner.username })

const otherOf = (session: PartnerBidSummary) => (session.seat === 'S' ? session.partner : session.inviter)

/** Where the session stands, in a few words */
function useStanding() {
  const { t } = usePreferences()
  const p = t.partnerBid
  return (session: PartnerBidSummary) => {
    if (session.status !== 'active') return p.status[session.status]
    return session.yourTurn ? p.yourTurn : p.theirTurn(otherOf(session).username)
  }
}

export function PartnerBiddingListPage() {
  const { t, message } = usePreferences()
  const p = t.partnerBid
  const { user } = useAuth()
  const { lobby, partnerBidLive } = useClub()
  const standing = useStanding()
  const [sessions, setSessions] = useState<PartnerBidSummary[] | null>(null)
  const [sets, setSets] = useState<PracticeSetInfo[]>([])
  const [partnerId, setPartnerId] = useState('')
  const [deal, setDeal] = useState<PartnerBidDeal>('random')
  const [setId, setSetId] = useState('')
  const [boards, setBoards] = useState(4)
  const kinds = robotKindsFor(user)
  const [robotKind, setRobotKind] = useState<RobotKind>(kinds[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const failed = useCallback((e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])
  const reload = useCallback(() => {
    api.partnerBids().then(({ sessions }) => setSessions(sessions), failed)
  }, [failed])
  useEffect(reload, [reload, partnerBidLive])
  useEffect(() => {
    api.practiceSets().then(({ sets }) => {
      setSets(sets)
      setSetId((id) => id || sets[0]?.id || '')
    }, () => {})
  }, [])

  const blocked = new Set(lobby?.blocked ?? [])
  const candidates = (lobby?.members ?? []).filter((m) => m.id !== user?.id && !isRobotId(m.id) && !blocked.has(m.id))

  const invite = async (event: FormEvent) => {
    event.preventDefault()
    if (!partnerId || busy) return
    setBusy(true)
    setError(null)
    try {
      await api.createPartnerBid(partnerId, {
        deal,
        boards,
        ...(deal === 'set' && { setId }),
        robotKind,
      })
      setPartnerId('')
      reload()
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageMain>
      <PageTitle>{p.title}</PageTitle>
      <Muted>{p.intro}</Muted>
      <Spaced>
        <Card>
          <h2>{p.newTitle}</h2>
          <Form onSubmit={(event) => void invite(event)}>
            <Field>
              <FieldLabel htmlFor="partner-bid-partner">{p.partner}</FieldLabel>
              <Select id="partner-bid-partner" value={partnerId} onChange={(event) => setPartnerId(event.target.value)} required>
                <option value="">{p.pickPartner}</option>
                {candidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.username}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="partner-bid-deal">{p.deals}</FieldLabel>
              <Select id="partner-bid-deal" value={deal} onChange={(event) => setDeal(event.target.value as PartnerBidDeal)}>
                <option value="random">{t.practiceDeals.random.label}</option>
                {DEAL_PRESET_IDS.map((id) => (
                  <option key={id} value={id}>
                    {t.practiceDeals[id].label}
                  </option>
                ))}
                {sets.length > 0 && <option value="set">{p.practiceSet}</option>}
              </Select>
            </Field>
            {deal === 'set' && (
              <Field>
                <FieldLabel htmlFor="partner-bid-set">{p.practiceSet}</FieldLabel>
                <Select id="partner-bid-set" value={setId} onChange={(event) => setSetId(event.target.value)}>
                  {sets.map((set) => (
                    <option key={set.id} value={set.id}>
                      {t.practiceSetNames[set.id] ?? set.id} · {t.practiceSetCount(set.count)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="partner-bid-boards">{p.boards}</FieldLabel>
              <Select id="partner-bid-boards" value={boards} onChange={(event) => setBoards(Number(event.target.value))}>
                {Array.from({ length: PARTNER_BID_BOARDS_MAX }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="partner-bid-system">{p.system}</FieldLabel>
              <Select id="partner-bid-system" value={robotKind} onChange={(event) => setRobotKind(event.target.value as RobotKind)}>
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {t.robotSystems[kind]}
                  </option>
                ))}
              </Select>
            </Field>
            {error && <ErrorText role="alert">{error}</ErrorText>}
            <div>
              <Button type="submit" $variant="primary" disabled={!partnerId || busy || (deal === 'set' && !setId)}>
                {p.invite}
              </Button>
            </div>
            <Muted>{p.limit(PARTNER_BID_ACTIVE_MAX, PARTNER_BID_INVITE_MS / DAY_MS, PARTNER_BID_IDLE_MS / DAY_MS, PARTNER_BID_KEEP_MS / DAY_MS)}</Muted>
          </Form>
        </Card>
        <Card>
          <h2>{p.mine}</h2>
          {sessions === null ? (
            <Muted role="status">{t.loading}</Muted>
          ) : sessions.length === 0 ? (
            <Muted>{p.none}</Muted>
          ) : (
            <Sessions>
              {sessions.map((session) => (
                <SessionRow key={session.id}>
                  <Link to={`/partner-bidding/${encodeURIComponent(session.id)}`}>{p.with_(otherOf(session).username)}</Link>
                  <span>
                    {p.done(session.done, session.boards)} · {session.yourTurn ? <TurnTag>{p.yourTurn}</TurnTag> : standing(session)}
                  </span>
                </SessionRow>
              ))}
            </Sessions>
          )}
        </Card>
      </Spaced>
    </PageMain>
  )
}

/** A session from the server, kept up to date by what the other member does */
function useSession(id: string | undefined) {
  const { t, message } = usePreferences()
  const { partnerBidLive } = useClub()
  const [fetched, setSession] = useState<PartnerBidView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const failed = useCallback((e: unknown) => setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError), [message, t.genericError])
  useEffect(() => {
    if (!id) return
    api.partnerBid(id).then(({ session }) => setSession(session), failed)
  }, [id, failed])
  // What the other member just did, or the review as it is worked out, unless an answer is newer
  const live = partnerBidLive?.id === id ? partnerBidLive : null
  if (live && !live.session) return { session: null, setSession, error: t.partnerBid.gone, setError, failed }
  const session = live?.session && (!fetched || live.session.updatedAt >= fetched.updatedAt) ? live.session : fetched
  return { session, setSession, error, setError, failed }
}

/** The board being bid: the member's hand, the auction, and the bidding box on their turn */
function CurrentBoard({
  session,
  board,
  busy,
  onCall,
}: {
  session: PartnerBidView
  board: PartnerBidBoardView
  busy: boolean
  onCall: (call: string) => void
}) {
  const { t } = usePreferences()
  const p = t.partnerBid
  const names = namesOf(session)
  const hand = board.hands[session.seat] ?? []
  return (
    <Card>
      <h2>{p.board(board.seq + 1, session.boards)}</h2>
      <Felt>
        <AuctionBox auction={board.auction} dealer={board.dealer} vul={board.vul} viewer={session.seat} turn={board.turn} names={names} />
        <HandView cards={hand} count={hand.length} width={44} label={p.yourHand} />
        {board.legalCalls.length > 0 && !busy && <BiddingBox legal={board.legalCalls} onCall={(call) => onCall(call)} />}
      </Felt>
      {board.turn && board.legalCalls.length === 0 && <Muted role="status">{p.theirTurn(otherOf(session).username)}</Muted>}
    </Card>
  )
}

export function PartnerBiddingPage() {
  const { sessionId } = useParams()
  const { t } = usePreferences()
  const p = t.partnerBid
  const standing = useStanding()
  const { session, setSession, error, setError, failed } = useSession(sessionId)
  const [busy, setBusy] = useState(false)

  const act = async (work: () => Promise<{ session: PartnerBidView }>) => {
    setBusy(true)
    setError(null)
    try {
      setSession((await work()).session)
    } catch (e) {
      failed(e)
    } finally {
      setBusy(false)
    }
  }

  const back = <Link to="/partner-bidding">{p.backToList}</Link>
  if (!session)
    return (
      <PageMain>
        <PageTitle>{p.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted role="status">{t.loading}</Muted>}
        <p>{back}</p>
      </PageMain>
    )

  const id = session.id
  const other = otherOf(session).username
  const current = session.sessionBoards.find((board) => !board.over)
  const done = session.sessionBoards.filter((board) => board.over)
  return (
    <PageMain>
      <PageTitle>
        {p.title} · {p.with_(other)}
      </PageTitle>
      <Muted>
        {p.done(session.done, session.boards)} · {standing(session)}
      </Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Spaced>
        {session.status === 'invited' &&
          (session.seat === 'N' ? (
            <Card>
              <p>{p.invitedBy(other)}</p>
              <Muted>{p.intro}</Muted>
              <Row>
                <Button type="button" $variant="primary" disabled={busy} onClick={() => void act(() => api.answerPartnerBid(id, true))}>
                  {p.accept}
                </Button>
                <Button type="button" disabled={busy} onClick={() => void act(() => api.answerPartnerBid(id, false))}>
                  {p.decline}
                </Button>
              </Row>
            </Card>
          ) : (
            <Card>
              <p>{p.waitingAnswer(other)}</p>
              <Button type="button" disabled={busy} onClick={() => void act(() => api.abandonPartnerBid(id))}>
                {p.withdraw}
              </Button>
            </Card>
          ))}
        {session.status === 'active' && current && (
          <CurrentBoard session={session} board={current} busy={busy} onCall={(call) => void act(() => api.callPartnerBid(id, call))} />
        )}
        {done.length > 0 && (
          <Card>
            <h2>{p.finishedBoards}</h2>
            <Sessions>
              {done.map((board) => (
                <SessionRow key={board.seq}>
                  <span>
                    {p.board(board.seq + 1, session.boards)} · {board.contract ? <ContractLabel contract={board.contract} /> : p.passedOut}
                  </span>
                  <Link to={`/partner-bidding/${encodeURIComponent(id)}/boards/${board.seq}`}>{p.review}</Link>
                </SessionRow>
              ))}
            </Sessions>
          </Card>
        )}
        {session.status === 'active' && (
          <div>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(p.abandonConfirm)) void act(() => api.abandonPartnerBid(id))
              }}
            >
              {p.abandon}
            </Button>
          </div>
        )}
      </Spaced>
      <p>{back}</p>
    </PageMain>
  )
}

/** 檢討 of a board whose auction ended: both members see the same page */
export function PartnerBidReviewPage() {
  const { sessionId, seq } = useParams()
  const { t } = usePreferences()
  const p = t.partnerBid
  const { session, error } = useSession(sessionId)
  const backToSession = <Link to={`/partner-bidding/${encodeURIComponent(sessionId ?? '')}`}>{p.back}</Link>
  const board = session?.sessionBoards.find((b) => b.seq === Number(seq) && b.over)
  if (!session || !board)
    return (
      <PageMain>
        <PageTitle>{p.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : session ? <Muted>{p.gone}</Muted> : <Muted role="status">{t.loading}</Muted>}
        <p>{backToSession}</p>
      </PageMain>
    )
  // All four hands are there once the auction ended; SEATS keeps the page from reading a missing one
  const hands = Object.fromEntries(SEATS.map((seat) => [seat, board.hands[seat] ?? []]))
  return (
    <PageMain>
      <PageTitle>{p.reviewTitle(board.seq + 1)}</PageTitle>
      <p>{backToSession}</p>
      <Card>
        <PracticeReviewBody
          board={{ ...board, hands }}
          review={board.review}
          note={board.note}
          names={namesOf(session)}
          robotHint={p.robotHint}
        />
      </Card>
    </PageMain>
  )
}

