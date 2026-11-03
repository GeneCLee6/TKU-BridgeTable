import { useCallback, useEffect, useId, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { rankLabel, rankOf, suitOf } from '../../shared/cards.ts'
import { MOVEMENT_PAIRS } from '../../shared/movement.ts'
import type { PairsSettings, PairsSummary, PairsView } from '../../shared/pairs.ts'
import { resultLabel } from '../../shared/scoring.ts'
import { RefereeNotes, RefereeTools } from '../components/RefereePanel.tsx'
import { RulingTag } from '../components/RulingTag.tsx'
import { ContractLabel, SuitSymbol } from '../components/Suit.tsx'
import { Button, Card, ErrorText, Input, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { cardName } from '../lib/cards.ts'
import { formatDateTime, signed } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import { seatLetter, type Strings } from '../strings.ts'

/**
 * 雙人賽 (`e9-t10`–`e9-t13`, AC-9.4, ARCHITECTURE.md §5.22): the list with the form for a new
 * event, and one event's page — the pairs entered, the director's start, each round's tables, the
 * live standings by field, the travellers and the member's own boards. What the server sends
 * already follows §4: a board's results at other tables only once the member's pair played it.
 * At a table, `components/PairsBanner.tsx` names the round and takes the player on.
 */

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 10px;

  & > label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }
`

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;

  & > li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    padding: 8px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
  & > li:first-child {
    border-top: 0;
  }
  & > li[aria-current='true'] {
    font-weight: 700;
  }
`

const Status = styled.span`
  padding: 1px 8px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: 13px;
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  border-collapse: collapse;
  width: 100%;
  font-size: 15px;
  white-space: nowrap;
  margin-bottom: 12px;

  th, td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
    font-weight: 600;
  }
  tr[aria-current='true'] td {
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
  }
  caption {
    text-align: left;
    font-weight: 700;
    padding: 4px 0;
  }
`

const Num = styled.td<{ $value?: number }>`
  text-align: right !important;
  font-variant-numeric: tabular-nums;
  color: ${({ $value, theme }) =>
    $value === undefined || $value === 0 ? 'inherit' : $value > 0 ? theme.colors.success : theme.colors.danger};
`

const percent = (value: number) => `${value.toFixed(2)}%`

const titleOf = (t: Strings, e: { title: string }) => e.title || t.pairs.untitled

function useErrorText() {
  const { message } = usePreferences()
  return useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)), [message])
}

/** A pair's name: its place in the movement once started, and its two players */
function pairLabel(t: Strings, view: PairsView, pair: number): string {
  const p = view.pairs[pair]
  if (!p) return '—'
  const names = p.players.map((u) => u.username || t.deletedMember).join(' – ')
  return p.dir ? `${t.pairs.pair(t.pairs.dirs[p.dir], p.no!)} ${names}` : names
}

// ── The list (`/pairs`) ─────────────────────────────────────────────────────────────────────

function CreateForm({ onCreated }: { onCreated: (view: PairsView) => void }) {
  const t = useT()
  const errorText = useErrorText()
  const id = useId()
  const [settings, setSettings] = useState<PairsSettings>({ title: '', boardsPerRound: 3, boardMinutes: 8 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <Section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.pairs.create}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          api.pairs
            .create(settings)
            .then((r) => onCreated(r.pairs))
            .catch((e) => setError(errorText(e)))
            .finally(() => setBusy(false))
        }}
      >
        <Row>
          <label>
            {t.pairs.name}
            <Input value={settings.title} maxLength={40} onChange={(e) => setSettings({ ...settings, title: e.target.value })} />
          </label>
          <label>
            {t.pairs.boardsPerRound}
            <Input
              type="number"
              min={1}
              max={4}
              value={settings.boardsPerRound}
              onChange={(e) => setSettings({ ...settings, boardsPerRound: Number(e.target.value) })}
            />
          </label>
          <label>
            {t.pairs.boardMinutes}
            <Input
              type="number"
              min={0}
              max={30}
              value={settings.boardMinutes}
              onChange={(e) => setSettings({ ...settings, boardMinutes: Number(e.target.value) })}
            />
          </label>
          <Button type="submit" $variant="primary" disabled={busy}>
            {t.pairs.create}
          </Button>
        </Row>
      </form>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </Section>
  )
}

export function PairsListPage() {
  const { t, lang } = usePreferences()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const [list, setList] = useState<PairsSummary[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.pairs
      .list()
      .then((r) => live && setList(r.pairs))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [errorText])

  return (
    <PageMain>
      <PageTitle>{t.pairs.title}</PageTitle>
      <Muted>{t.pairs.intro}</Muted>
      <CreateForm onCreated={(view) => navigate(`/pairs/${view.id}`)} />
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Section aria-label={t.pairs.title}>
        {!list ? (
          <Muted>{t.loading}</Muted>
        ) : !list.length ? (
          <Muted>{t.pairs.none}</Muted>
        ) : (
          <List>
            {list.map((e) => (
              <li key={e.id} aria-current={e.mine ? 'true' : undefined}>
                <Link to={`/pairs/${e.id}`}>{titleOf(t, e)}</Link>
                <Status>{t.pairs.status[e.status]}</Status>
                <Muted as="span">{t.pairs.pairsCount(e.pairs)}</Muted>
                {e.status === 'playing' && <Muted as="span">{t.pairs.roundOf(e.round, e.rounds)}</Muted>}
                <Muted as="span">{t.pairs.director(e.director.username)}</Muted>
                <Muted as="span">{formatDateTime(e.createdAt, lang)}</Muted>
              </li>
            ))}
          </List>
        )}
      </Section>
    </PageMain>
  )
}

// ── One event (`/pairs/:eventId`) ───────────────────────────────────────────────────────────

/** NS and EW ranked apart, the viewer's pair highlighted */
function Standings({ view }: { view: PairsView }) {
  const t = useT()
  if (!view.standings.length) return null
  return (
    <>
      {(['NS', 'EW'] as const).map((dir) => (
        <Scroll key={dir}>
          <Table>
            <caption>{t.pairs.dirs[dir]}</caption>
            <thead>
              <tr>
                <th scope="col">{t.rankCol}</th>
                <th scope="col">{t.pairs.entries}</th>
                <th scope="col">{t.pairs.boardsCol}</th>
                <th scope="col">{t.pairs.mp}</th>
                <th scope="col">{t.pairs.percent}</th>
              </tr>
            </thead>
            <tbody>
              {view.standings
                .filter((s) => s.dir === dir)
                .map((s) => (
                  <tr key={s.pair} aria-current={s.pair === view.myPair ? 'true' : undefined}>
                    <td>{s.boards ? s.rank : '—'}</td>
                    <td>
                      {pairLabel(t, view, s.pair)}
                      {/* The director's penalty (e9-t17), already out of the MP */}
                      {s.penalty !== undefined && <Muted as="span"> · {t.referee.penaltyMark(String(s.penalty))}</Muted>}
                    </td>
                    <Num>{s.boards}</Num>
                    <Num>{s.mp.toFixed(1)}</Num>
                    <Num>{s.boards ? percent(s.percent) : '—'}</Num>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Scroll>
      ))}
    </>
  )
}

/** Each board the viewer may see: every table's result, best for NS first */
function Travellers({ view }: { view: PairsView }) {
  const t = useT()
  return (
    <>
      {view.travellers.map((tr) => (
        <Scroll key={tr.boardNo}>
          <Table>
            <caption>{t.pairs.board(tr.boardNo)}</caption>
            <thead>
              <tr>
                <th scope="col">{t.pairs.roundCol}</th>
                <th scope="col">{t.pairs.nsCol}</th>
                <th scope="col">{t.pairs.ewCol}</th>
                <th scope="col">{t.contract}</th>
                <th scope="col">{t.openingLead}</th>
                <th scope="col">{t.result}</th>
                <th scope="col">{t.scoreNS}</th>
                <th scope="col">{t.pairs.nsCol} %</th>
              </tr>
            </thead>
            <tbody>
              {tr.entries.map((e) => {
                const mine = e.ns === view.myPair || e.ew === view.myPair
                return (
                  <tr key={`${e.round}-${e.table}`} aria-current={mine ? 'true' : undefined}>
                    <td>{e.round}</td>
                    <td>{pairLabel(t, view, e.ns)}</td>
                    <td>{pairLabel(t, view, e.ew)}</td>
                    <td>
                      {e.boardId ? (
                        <Link to={`/history/${e.boardId}`}>
                          <ContractLabel contract={e.contract} />
                        </Link>
                      ) : (
                        <ContractLabel contract={e.contract} />
                      )}
                      {e.contract && ` ${seatLetter[e.contract.declarer]}`}
                    </td>
                    <td aria-label={e.lead ? cardName(e.lead, t) : undefined}>
                      {e.lead ? (
                        <>
                          <SuitSymbol suit={suitOf(e.lead)} />
                          {rankLabel(rankOf(e.lead))}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{e.contract && e.declarerTricks !== null ? resultLabel(e.contract, e.declarerTricks) : '—'}</td>
                    <Num $value={e.scoreNS}>
                      {e.contract || !e.ruling ? signed(e.scoreNS) : '—'}
                      {e.ruling && <RulingTag ruling={e.ruling} />}
                    </Num>
                    <Num>{percent(e.percentNS)}</Num>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </Scroll>
      ))}
    </>
  )
}

/** What the director did (e9-t17), and the director's tools */
function PairsReferee({ view, onDone }: { view: PairsView; onDone: () => void }) {
  const t = useT()
  const notes = view.referee ?? []
  const label = (target: string) => pairLabel(t, view, Number(target))
  const started = view.status === 'playing' || view.status === 'finished'
  return (
    <Section aria-labelledby="pairs-referee">
      <h2 id="pairs-referee">{view.canReferee ? t.referee.title : t.referee.notes}</h2>
      {notes.length > 0 && <Muted>{t.referee.notesHint}</Muted>}
      <RefereeNotes notes={notes} targetLabel={label} unit={t.referee.units.mp} />
      {view.canReferee && view.status !== 'cancelled' && (
        <>
          {started && <Muted>{t.referee.recordHint}</Muted>}
          <RefereeTools
            kind="pairs"
            eventId={view.id}
            targets={started ? view.pairs.map((p) => ({ value: String(p.pair), label: pairLabel(t, view, p.pair) })) : []}
            targetLabel={label}
            unit={t.referee.units.mp}
            notes={notes}
            tables={
              view.status === 'playing'
                ? view.tables.map((tb) => ({ table: tb.table, boards: tb.boards, label: t.pairs.tableLine(tb.table, tb.played, tb.boards.length) }))
                : []
            }
            canDelay={view.status === 'open'}
            onDone={onDone}
          />
        </>
      )}
    </Section>
  )
}

/** The viewer's pair, board by board: the opponents, the score and the percentage for their side */
function MyBoards({ view }: { view: PairsView }) {
  const t = useT()
  const pair = view.myPair
  if (pair === undefined) return null
  const rows = view.travellers.flatMap((tr) =>
    tr.entries.filter((e) => e.ns === pair || e.ew === pair).map((e) => ({ boardNo: tr.boardNo, e, ns: e.ns === pair })),
  )
  if (!rows.length) return null
  return (
    <Scroll>
      <Table>
        <caption>{t.pairs.mine}</caption>
        <thead>
          <tr>
            <th scope="col">{t.pairs.roundCol}</th>
            <th scope="col">{t.board}</th>
            <th scope="col">{t.pairs.against}</th>
            <th scope="col">{t.contract}</th>
            <th scope="col">{t.scoreNS}</th>
            <th scope="col">{t.pairs.percent}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ boardNo, e, ns }) => (
            <tr key={boardNo}>
              <td>{e.round}</td>
              <td>{e.boardId ? <Link to={`/history/${e.boardId}`}>{boardNo}</Link> : boardNo}</td>
              <td>{pairLabel(t, view, ns ? e.ew : e.ns)}</td>
              <td>
                <ContractLabel contract={e.contract} />
              </td>
              <Num $value={e.scoreNS}>{signed(e.scoreNS)}</Num>
              <Num>{percent(ns ? e.percentNS : 100 - e.percentNS)}</Num>
            </tr>
          ))}
        </tbody>
      </Table>
    </Scroll>
  )
}

/** Entering with a partner (by username), while entries are open */
function EnterForm({ view, onChange }: { view: PairsView; onChange: (view: PairsView) => void }) {
  const t = useT()
  const errorText = useErrorText()
  const [partner, setPartner] = useState('')
  const [error, setError] = useState('')
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        api.pairs
          .enter(view.id, partner)
          .then((r) => {
            setPartner('')
            onChange(r.pairs)
          })
          .catch((e) => setError(errorText(e)))
      }}
    >
      <Row>
        <label>
          {t.pairs.partner}
          <Input value={partner} onChange={(e) => setPartner(e.target.value)} autoComplete="off" />
        </label>
        <Button type="submit" $variant="primary" disabled={!partner.trim()}>
          {t.pairs.enter}
        </Button>
      </Row>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </form>
  )
}

export function PairsEventPage() {
  const { eventId = '' } = useParams()
  const { t, lang } = usePreferences()
  const errorText = useErrorText()
  const { user } = useAuth()
  const { lobby } = useClub()
  const location = useLocation()
  // Coming back from a table while the pair waits (`usePairsFollow`): on to the next table when it opens
  const following = !!(location.state as { follow?: boolean } | null)?.follow
  const [view, setView] = useState<PairsView | null>(null)
  const [error, setError] = useState('')
  const here = lobby?.myTableId ?? null

  const load = useCallback(() => {
    api.pairs
      .get(eventId)
      .then((r) => setView(r.pairs))
      .catch((e) => setError(errorText(e)))
  }, [eventId, errorText])
  useEffect(load, [load, here])
  // The live standings: read again every few seconds while the event is played
  const playing = view?.status === 'playing'
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [playing, load])

  const act = (run: () => Promise<{ pairs: PairsView }>) => {
    setError('')
    run()
      .then((r) => setView(r.pairs))
      .catch((e) => setError(errorText(e)))
  }

  if (!user) return null
  const tableId = view?.myTable?.tableId
  if (following && tableId && here === tableId) return <Navigate to={`/table/${tableId}`} />
  if (!view)
    return (
      <PageMain>
        <PageTitle>{t.pairs.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
      </PageMain>
    )
  const mine = view.myPair !== undefined
  return (
    <PageMain>
      <PageTitle>{titleOf(t, view)}</PageTitle>
      <Row>
        <Status>{t.pairs.status[view.status]}</Status>
        <Muted as="span">{t.pairs.director(view.director.username)}</Muted>
        <Muted as="span">{formatDateTime(view.startedAt ?? view.createdAt, lang)}</Muted>
        {view.movement && (
          <Muted as="span">
            {t.pairs.plan(view.movement.tables, view.movement.rounds, view.movement.boardsPerRound, view.movement.boards)}
          </Muted>
        )}
      </Row>
      {view.delayedUntil !== undefined && <Muted role="status">{t.referee.delayed(formatDateTime(view.delayedUntil, lang))}</Muted>}
      {error && <ErrorText role="alert">{error}</ErrorText>}

      {view.status === 'playing' && (
        <Section aria-labelledby="pairs-round">
          <h2 id="pairs-round">
            {t.pairs.thisRound} · {t.pairs.roundOf(view.round, view.movement!.rounds)}
          </h2>
          {view.myTable === null && <Muted>{t.pairs.sitOut}</Muted>}
          {view.myTable && (
            <Row>
              <span>{t.pairs.myTable(view.myTable.table)}</span>
              <Button as={Link} to={`/table/${view.myTable.tableId}`} $variant="primary" $small>
                {t.pairs.goToTable}
              </Button>
            </Row>
          )}
          <List>
            {view.tables.map((tb) => (
              <li key={tb.table} aria-current={tb.table === view.myTable?.table ? 'true' : undefined}>
                <span>{t.pairs.tableLine(tb.table, tb.played, tb.boards.length)}</span>
                <Muted as="span">
                  {pairLabel(t, view, tb.ns)} · {pairLabel(t, view, tb.ew)}
                </Muted>
              </li>
            ))}
          </List>
        </Section>
      )}

      {view.status === 'open' && (
        <Section aria-labelledby="pairs-entries">
          <h2 id="pairs-entries">{t.pairs.entries}</h2>
          {!view.pairs.length ? (
            <Muted>{t.pairs.noEntries}</Muted>
          ) : (
            <List>
              {view.pairs.map((p) => (
                <li key={p.pair} aria-current={p.pair === view.myPair ? 'true' : undefined}>
                  <span>{pairLabel(t, view, p.pair)}</span>
                  {(p.pair === view.myPair || view.canDirect) && (
                    <Button
                      type="button"
                      $small
                      $variant="ghost"
                      onClick={() => act(() => api.pairs.withdraw(view.id, p.players[0].id))}
                    >
                      {p.pair === view.myPair ? t.pairs.withdraw : t.pairs.remove}
                    </Button>
                  )}
                </li>
              ))}
            </List>
          )}
          {!mine && <EnterForm view={view} onChange={setView} />}
          {view.canDirect && (
            <>
              <Muted>{t.pairs.startHint(MOVEMENT_PAIRS.min, MOVEMENT_PAIRS.max)}</Muted>
              <Row>
                <Button type="button" $variant="primary" onClick={() => act(() => api.pairs.start(view.id))}>
                  {t.pairs.start}
                </Button>
                <Button
                  type="button"
                  $variant="danger"
                  onClick={() => window.confirm(t.pairs.confirmCancel) && act(() => api.pairs.cancel(view.id))}
                >
                  {t.pairs.cancel}
                </Button>
              </Row>
            </>
          )}
        </Section>
      )}

      {view.status !== 'open' && view.status !== 'cancelled' && (
        <>
          <Section aria-labelledby="pairs-standings">
            <h2 id="pairs-standings">{t.pairs.standings}</h2>
            {view.status === 'playing' && <Muted>{t.pairs.standingsLive}</Muted>}
            <Standings view={view} />
          </Section>
          <Section aria-labelledby="pairs-mine">
            <h2 id="pairs-mine">{t.pairs.travellers}</h2>
            {view.status === 'playing' && <Muted>{t.pairs.travellersHidden}</Muted>}
            <MyBoards view={view} />
            <Travellers view={view} />
          </Section>
        </>
      )}

      {(!!view.referee?.length || !!view.canReferee) && <PairsReferee view={view} onDone={load} />}
    </PageMain>
  )
}
