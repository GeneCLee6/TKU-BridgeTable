import { useCallback, useEffect, useId, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'
import { TEAM_EVENT_LIMITS } from '../../shared/team-event.ts'
import {
  DEFAULT_TEAMS,
  entrySizes,
  TOURNAMENT_KINDS,
  TOURNAMENT_LIMITS,
  type TournamentKind,
  type TournamentSettings,
  type TournamentSummary,
  type TournamentView,
} from '../../shared/tournament.ts'
import { Button, Card, ErrorText, Input, Muted, PageMain, PageTitle, Select, Textarea } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { usePreferences, useT } from '../state/PreferencesContext.tsx'
import type { Strings } from '../strings.ts'

/**
 * 比賽公告與報名 (`e9-t16`, AC-9.7, ARCHITECTURE.md §5.24): the list with the admins' form for a new
 * announcement, and one tournament's page — when and what, the entries, entering alone, with a
 * partner or as a team, confirming, withdrawing, and for admins the start (which makes the pairs
 * event or the team match from the entries), changing, cancelling and removing entries. The event
 * itself is played on its own page (`/pairs/:id`, `/matches/:id`), which the page links.
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
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-weight: 700;
  }
`

const Wide = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
  font-weight: 700;
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

const Pending = styled.span`
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
`

const Description = styled.p`
  white-space: pre-wrap;
  margin: 0 0 10px;
`

const Meta = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-bottom: 10px;
`

function useErrorText() {
  const { message } = usePreferences()
  return useCallback((e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)), [message])
}

/** `datetime-local` works in the browser's own time zone */
function toLocalInput(at: number): string {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}
const fromLocalInput = (value: string) => (value ? new Date(value).getTime() : NaN)

const usedLabel = (t: Strings, s: TournamentSummary) =>
  s.kind === 'pairs'
    ? t.tournaments.pairsUsed(s.used, s.capacity)
    : s.kind === 'individual'
      ? t.tournaments.playersUsed(s.used, s.capacity)
      : t.tournaments.teamsUsed(s.used, s.capacity)

/** Splits the usernames typed into a box: commas, the full-width one, or spaces */
const names = (value: string) => value.split(/[\s,，、]+/).filter(Boolean)

// ── The admins' form ────────────────────────────────────────────────────────────────────────

function TournamentForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial?: TournamentView
  onSaved: (view: TournamentView) => void
  onCancel?: () => void
}) {
  const t = useT()
  const errorText = useErrorText()
  const id = useId()
  const [settings, setSettings] = useState<TournamentSettings>(
    () =>
      initial?.settings ?? {
        kind: 'pairs',
        title: '',
        description: '',
        startsAt: Date.now() + 7 * 86_400_000,
        deadline: Date.now() + 6 * 86_400_000,
        capacity: TOURNAMENT_LIMITS.pairsMax,
        pairs: { boardsPerRound: 3, boardMinutes: 8 },
        match: { boards: 8, scoring: 'imp', boardMinutes: 10 },
        teams: DEFAULT_TEAMS,
      },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch: Partial<TournamentSettings>) => setSettings((s) => ({ ...s, ...patch }))
  const teams = settings.teams ?? DEFAULT_TEAMS
  const setTeams = (patch: Partial<typeof teams>) => set({ teams: { ...teams, ...patch } })
  const tt = t.tournaments
  return (
    <form
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        const save = initial ? api.tournaments.update(initial.id, settings) : api.tournaments.create(settings)
        save
          .then((r) => onSaved(r.tournament))
          .catch((e) => setError(errorText(e)))
          .finally(() => setBusy(false))
      }}
    >
      <h2 id={`${id}-title`}>{initial ? tt.edit : tt.create}</h2>
      <Row>
        <label>
          {tt.name}
          <Input value={settings.title} maxLength={TOURNAMENT_LIMITS.titleMax} required onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label>
          {tt.kind}
          <Select
            value={settings.kind}
            disabled={!!initial?.entries.length}
            onChange={(e) => {
              const kind = e.target.value as TournamentKind
              // Each kind's own number of places: players (8–20), pairs (5–20), teams (3–16), two teams
              const capacity =
                kind === 'individual'
                  ? TOURNAMENT_LIMITS.playersMax
                  : kind === 'pairs'
                    ? TOURNAMENT_LIMITS.pairsMax
                    : kind === 'teams'
                      ? TOURNAMENT_LIMITS.teamsMax
                      : TOURNAMENT_LIMITS.teams
              set({ kind, capacity })
            }}
          >
            {TOURNAMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {tt.kinds[k]}
              </option>
            ))}
          </Select>
        </label>
      </Row>
      <Row>
        <label>
          {tt.startsAt}
          <Input type="datetime-local" value={toLocalInput(settings.startsAt)} onChange={(e) => set({ startsAt: fromLocalInput(e.target.value) })} />
        </label>
        <label>
          {tt.deadline}
          <Input type="datetime-local" value={toLocalInput(settings.deadline)} onChange={(e) => set({ deadline: fromLocalInput(e.target.value) })} />
        </label>
      </Row>
      {settings.kind === 'pairs' || settings.kind === 'individual' ? (
        <Row>
          <label>
            {settings.kind === 'individual' ? tt.capacityPlayers : tt.capacity}
            <Input
              type="number"
              min={settings.kind === 'individual' ? TOURNAMENT_LIMITS.playersMin : TOURNAMENT_LIMITS.pairsMin}
              max={settings.kind === 'individual' ? TOURNAMENT_LIMITS.playersMax : TOURNAMENT_LIMITS.pairsMax}
              value={settings.capacity}
              onChange={(e) => set({ capacity: Number(e.target.value) })}
            />
          </label>
          <label>
            {tt.boardsPerRound}
            <Input
              type="number"
              min={1}
              max={4}
              value={settings.pairs.boardsPerRound}
              onChange={(e) => set({ pairs: { ...settings.pairs, boardsPerRound: Number(e.target.value) } })}
            />
          </label>
          <label>
            {tt.boardMinutes}
            <Input
              type="number"
              min={0}
              max={30}
              value={settings.pairs.boardMinutes}
              onChange={(e) => set({ pairs: { ...settings.pairs, boardMinutes: Number(e.target.value) } })}
            />
          </label>
        </Row>
      ) : settings.kind === 'teams' ? (
        <Row>
          <label>
            {tt.capacityTeams}
            <Input
              type="number"
              min={TOURNAMENT_LIMITS.teamsMin}
              max={TOURNAMENT_LIMITS.teamsMax}
              value={settings.capacity}
              onChange={(e) => set({ capacity: Number(e.target.value) })}
            />
          </label>
          <label>
            {tt.boards}
            <Input
              type="number"
              min={TEAM_EVENT_LIMITS.boardsMin}
              max={TEAM_EVENT_LIMITS.boardsMax}
              value={teams.boards}
              onChange={(e) => setTeams({ boards: Number(e.target.value) })}
            />
          </label>
          <label>
            {tt.rounds}
            <Input
              type="number"
              min={TEAM_EVENT_LIMITS.roundsMin}
              max={TEAM_EVENT_LIMITS.roundsMax}
              value={teams.rounds}
              onChange={(e) => setTeams({ rounds: Number(e.target.value) })}
            />
          </label>
          <label>
            {tt.boardMinutes}
            <Input type="number" min={0} max={30} value={teams.boardMinutes} onChange={(e) => setTeams({ boardMinutes: Number(e.target.value) })} />
          </label>
        </Row>
      ) : (
        <Row>
          <label>
            {tt.boards}
            <Input
              type="number"
              min={4}
              max={32}
              value={settings.match.boards}
              onChange={(e) => set({ match: { ...settings.match, boards: Number(e.target.value) } })}
            />
          </label>
          <label>
            {tt.scoring}
            <Select
              value={settings.match.scoring}
              onChange={(e) => set({ match: { ...settings.match, scoring: e.target.value as 'imp' | 'bam' } })}
            >
              <option value="imp">IMP</option>
              <option value="bam">BAM</option>
            </Select>
          </label>
          <label>
            {tt.boardMinutes}
            <Input
              type="number"
              min={0}
              max={30}
              value={settings.match.boardMinutes}
              onChange={(e) => set({ match: { ...settings.match, boardMinutes: Number(e.target.value) } })}
            />
          </label>
        </Row>
      )}
      <Wide>
        {tt.description}
        <Textarea
          rows={4}
          maxLength={TOURNAMENT_LIMITS.descriptionMax}
          value={settings.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Wide>
      <Row>
        <Button type="submit" $variant="primary" disabled={busy || !settings.title.trim()}>
          {initial ? tt.save : tt.create}
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel}>
            {tt.cancelEdit}
          </Button>
        )}
      </Row>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </form>
  )
}

// ── The list (`/tournaments`) ───────────────────────────────────────────────────────────────

export function TournamentsListPage() {
  const { t, lang } = usePreferences()
  const { user } = useAuth()
  const errorText = useErrorText()
  const navigate = useNavigate()
  const [list, setList] = useState<TournamentSummary[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api.tournaments
      .list()
      .then((r) => live && setList(r.tournaments))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [errorText])

  return (
    <PageMain>
      <PageTitle>{t.tournaments.title}</PageTitle>
      <Muted>{t.tournaments.intro}</Muted>
      {user?.admin && (
        <Section>
          <TournamentForm onSaved={(view) => navigate(`/tournaments/${view.id}`)} />
        </Section>
      )}
      {error && <ErrorText role="alert">{error}</ErrorText>}
      <Section aria-label={t.tournaments.title}>
        {!list ? (
          <Muted>{t.loading}</Muted>
        ) : !list.length ? (
          <Muted>{t.tournaments.none}</Muted>
        ) : (
          <List>
            {list.map((s) => (
              <li key={s.id} aria-current={s.mine ? 'true' : undefined}>
                <Link to={`/tournaments/${s.id}`}>{s.title}</Link>
                <Status>{t.tournaments.status[s.status]}</Status>
                <Muted as="span">{t.tournaments.kinds[s.kind]}</Muted>
                <Muted as="span">{t.tournaments.when(formatDateTime(s.startsAt, lang))}</Muted>
                <Muted as="span">{usedLabel(t, s)}</Muted>
              </li>
            ))}
          </List>
        )}
      </Section>
    </PageMain>
  )
}

// ── One tournament (`/tournaments/:id`) ─────────────────────────────────────────────────────

/** Entering: alone or with a partner for a pairs event, a team of four for a team match */
function EnterForm({ view, onChange }: { view: TournamentView; onChange: (view: TournamentView) => void }) {
  const t = useT()
  const tt = t.tournaments
  const errorText = useErrorText()
  const [partners, setPartners] = useState('')
  const [teamName, setTeamName] = useState('')
  const [error, setError] = useState('')
  const team = view.kind === 'match' || view.kind === 'teams'
  // An individual event (e9-t15): everyone enters alone
  const alone = view.kind === 'individual'
  // Teammates besides oneself: three for a team match, three to five for a multi-team event (e9-t14)
  const sizes = entrySizes(view.kind).map((n) => n - 1)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        api.tournaments
          .enter(view.id, alone ? [] : names(partners), team ? teamName : undefined)
          .then((r) => {
            setPartners('')
            onChange(r.tournament)
          })
          .catch((e) => setError(errorText(e)))
      }}
    >
      <Row>
        {team && (
          <label>
            {tt.teamName}
            <Input value={teamName} maxLength={TOURNAMENT_LIMITS.teamNameMax} onChange={(e) => setTeamName(e.target.value)} />
          </label>
        )}
        {!alone && (
          <label>
            {view.kind === 'teams' ? tt.teammatesMany : team ? tt.teammates : tt.partner}
            <Input value={partners} onChange={(e) => setPartners(e.target.value)} autoComplete="off" />
          </label>
        )}
        <Button type="submit" $variant="primary" disabled={team && !sizes.includes(names(partners).length)}>
          {team ? tt.enterTeam : !alone && names(partners).length ? tt.enterPair : tt.enterAlone}
        </Button>
      </Row>
      {error && <ErrorText role="alert">{error}</ErrorText>}
    </form>
  )
}

/**
 * How the members who entered alone will be paired at the start (2026-11-03): two by two in the
 * order they entered, unless an admin changed it. An admin swaps any two of them here (the server
 * checks the new order, `tournamentBadPairing`) or goes back to the order they entered
 */
function SinglesPairing({
  view,
  busy,
  act,
}: {
  view: TournamentView
  busy: boolean
  act: (run: () => Promise<{ tournament: TournamentView }>) => void
}) {
  const { t } = usePreferences()
  const tt = t.tournaments
  const singles = view.singles
  if (!singles) return null
  const order = [...singles.pairs.flat(), ...singles.leftOver]
  const nameOf = (u: (typeof order)[number]) => u.username || t.deletedMember
  const swap = (a: string, b: string) => {
    const next = order.map((u) => (u.id === a ? b : u.id === b ? a : u.id))
    act(() => api.tournaments.pairing(view.id, next))
  }
  const person = (u: (typeof order)[number]) => (
    <span key={u.id}>
      <Link to={`/members/${u.id}`}>{nameOf(u)}</Link>
      {view.canManage && order.length > 1 && (
        <Select
          aria-label={tt.swapLabel(nameOf(u))}
          value=""
          disabled={busy}
          onChange={(e) => e.target.value && swap(u.id, e.target.value)}
        >
          <option value="">{tt.swapPick}</option>
          {order
            .filter((o) => o.id !== u.id)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {nameOf(o)}
              </option>
            ))}
        </Select>
      )}
    </span>
  )
  return (
    <Section aria-labelledby="tournament-singles">
      <h2 id="tournament-singles">{tt.singles}</h2>
      <Muted>{tt.singlesHint}</Muted>
      {singles.adjusted && <Muted>{tt.singlesAdjusted}</Muted>}
      <List>
        {singles.pairs.map((pair, i) => (
          <li key={pair[0].id}>
            <strong>{tt.singlesPair(i + 1)}</strong>
            {pair.map(person)}
          </li>
        ))}
        {singles.leftOver.map((u) => (
          <li key={u.id}>
            <Pending>{tt.singlesLeftOver}</Pending>
            {person(u)}
          </li>
        ))}
      </List>
      {view.canManage && singles.adjusted && (
        <Row>
          <Button type="button" $size="sm" disabled={busy} onClick={() => act(() => api.tournaments.pairing(view.id, null))}>
            {tt.singlesReset}
          </Button>
        </Row>
      )}
    </Section>
  )
}

export function TournamentPage() {
  const { t, lang } = usePreferences()
  const tt = t.tournaments
  const { user } = useAuth()
  const { tournamentId = '' } = useParams()
  const errorText = useErrorText()
  const [view, setView] = useState<TournamentView | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    api.tournaments
      .get(tournamentId)
      .then((r) => live && setView(r.tournament))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [tournamentId, errorText])

  const act = (run: () => Promise<{ tournament: TournamentView }>) => {
    setBusy(true)
    setError('')
    run()
      .then((r) => setView(r.tournament))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }

  if (!view)
    return (
      <PageMain>
        <PageTitle>{tt.title}</PageTitle>
        {error ? <ErrorText role="alert">{error}</ErrorText> : <Muted>{t.loading}</Muted>}
        <Link to="/tournaments">{tt.back}</Link>
      </PageMain>
    )

  const mine = view.entries.find((e) => e.id === view.myEntry)
  const playerNames = (e: TournamentView['entries'][number]) => e.players.map((p) => p.username || t.deletedMember).join('、')

  return (
    <PageMain>
      <PageTitle>{view.title}</PageTitle>
      <Section aria-label={view.title}>
        <Meta>
          <Status>{tt.status[view.status]}</Status>
          <span>{tt.kinds[view.kind]}</span>
          <span>{tt.when(formatDateTime(view.startsAt, lang))}</span>
          <span>{tt.until(formatDateTime(view.deadline, lang))}</span>
          <span>{usedLabel(t, view)}</span>
          <Muted as="span">{tt.by(view.createdBy.username || t.deletedMember)}</Muted>
        </Meta>
        {view.description && <Description>{view.description}</Description>}
        {view.eventLink && (
          <Row>
            <Link to={view.eventLink}>{view.status === 'finished' ? tt.results : tt.goEvent}</Link>
          </Row>
        )}
        {view.status === 'finished' && <Muted>{tt.finishedNote}</Muted>}
      </Section>

      {error && <ErrorText role="alert">{error}</ErrorText>}

      {view.status === 'open' && (
        <Section aria-label={tt.entries}>
          {view.myPending ? (
            <Row>
              <span>{tt.youPending}</span>
              <Button type="button" $variant="primary" disabled={busy} onClick={() => act(() => api.tournaments.answer(view.id, true))}>
                {tt.confirm}
              </Button>
              {view.entriesOpen && (
                <Button type="button" disabled={busy} onClick={() => act(() => api.tournaments.answer(view.id, false))}>
                  {tt.decline}
                </Button>
              )}
            </Row>
          ) : mine ? (
            <Row>
              <span>{tt.youIn}</span>
              {view.entriesOpen && (
                <Button type="button" disabled={busy} onClick={() => act(() => api.tournaments.withdraw(view.id))}>
                  {tt.withdraw}
                </Button>
              )}
            </Row>
          ) : view.entriesOpen ? (
            <EnterForm view={view} onChange={setView} />
          ) : (
            <Muted>{tt.closed}</Muted>
          )}
        </Section>
      )}

      <Section aria-labelledby="tournament-entries">
        <h2 id="tournament-entries">{tt.entries}</h2>
        {!view.entries.length ? (
          <Muted>{tt.noEntries}</Muted>
        ) : (
          <List>
            {view.entries.map((e, i) => (
              <li key={e.id} aria-current={e.id === view.myEntry ? 'true' : undefined}>
                {(view.kind === 'match' || view.kind === 'teams') && <strong>{e.teamName || tt.team(i + 1)}</strong>}
                {e.players.map((p) => (
                  <span key={p.id}>
                    <Link to={`/members/${p.id}`}>{p.username || t.deletedMember}</Link>
                    {!p.confirmed && <Pending>（{tt.pending}）</Pending>}
                  </span>
                ))}
                {view.kind === 'pairs' && e.players.length === 1 && <Pending>{tt.alone}</Pending>}
                {view.canManage && view.status === 'open' && (
                  <Button
                    type="button"
                    $size="sm"
                    disabled={busy}
                    aria-label={tt.removeLabel(playerNames(e))}
                    onClick={() => act(() => api.tournaments.remove(view.id, e.id))}
                  >
                    {tt.remove}
                  </Button>
                )}
              </li>
            ))}
          </List>
        )}
      </Section>

      <SinglesPairing view={view} busy={busy} act={act} />

      {view.canManage && view.status === 'open' && (
        <Section aria-label={tt.edit}>
          {editing ? (
            <TournamentForm
              initial={view}
              onSaved={(next) => {
                setView(next)
                setEditing(false)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <Muted>
                {view.kind === 'pairs'
                  ? tt.startHintPairs
                  : view.kind === 'individual'
                    ? tt.startHintIndividual
                    : view.kind === 'teams'
                      ? tt.startHintTeams
                      : tt.startHintMatch}
              </Muted>
              <Row>
                <Button type="button" $variant="primary" disabled={busy} onClick={() => act(() => api.tournaments.start(view.id))}>
                  {tt.start}
                </Button>
                <Button type="button" disabled={busy} onClick={() => setEditing(true)}>
                  {tt.edit}
                </Button>
                <Button
                  type="button"
                  $variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(tt.confirmCancel)) act(() => api.tournaments.cancel(view.id))
                  }}
                >
                  {tt.cancel}
                </Button>
              </Row>
            </>
          )}
        </Section>
      )}
      {user && <Link to="/tournaments">{tt.back}</Link>}
    </PageMain>
  )
}
