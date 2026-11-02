import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import { taiwanDay } from '../../shared/daily-event.ts'
import {
  POINT_KINDS,
  shiftMonth,
  taiwanMonth,
  type LeaderboardView,
  type LedgerEntry,
  type PointKind,
  type PointsKindRule,
  type PointsRules,
  type Season,
} from '../../shared/points.ts'
import { Button, Card, ErrorText, Input, Muted, PageMain, PageTitle, Select } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import { formatDate } from '../lib/format.ts'
import { useAuth, useFeature } from '../state/AuthContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { playerName } from '../strings.ts'

/**
 * 社團積分榜 (`e9-t06`, AC-9.2, ARCHITECTURE.md §5.21): the month's and the year's (or a season's)
 * boards, each member's entries traced to their events, and for admins the points rules, the
 * seasons and corrections to an entry (`e9-t04`, `e9-t05`). Members see it with the `rankings` flag.
 */

type Choice = { kind: 'month'; key: string } | { kind: 'year'; key: string } | { kind: 'season'; key: string }

const query = (c: Choice) => `${c.kind}=${encodeURIComponent(c.key)}`

const Section = styled(Card)`
  margin-bottom: 16px;

  & > h2 {
    margin: 0 0 10px;
    font-size: 18px;
    color: ${({ theme }) => theme.colors.text};
  }
`

const Bar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 12px;

  & > strong {
    font-size: 16px;
    min-width: 7em;
    text-align: center;
  }
`

const Tabs = styled.div`
  display: inline-flex;
  gap: 4px;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;

  th,
  td {
    padding: 6px 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  td.num,
  th.num {
    text-align: right;
  }
  tr[aria-current='true'] > td {
    background: ${({ theme }) => theme.colors.primarySoft};
    font-weight: 700;
  }
`

const Entries = styled.ul`
  margin: 4px 0 8px;
  padding: 0;
  list-style: none;

  & > li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    padding: 6px 0;
    border-top: 1px solid ${({ theme }) => theme.colors.border};
  }
  & > li:first-child {
    border-top: 0;
  }
`

const Points = styled.strong`
  margin-left: auto;
  font-variant-numeric: tabular-nums;
`

const Form = styled.form`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 8px;

  & label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  & input[type='number'] {
    width: 5.5em;
  }
`

const RuleGrid = styled.table`
  border-collapse: collapse;
  margin: 8px 0;

  th,
  td {
    padding: 4px 8px;
    text-align: left;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
  }
  input[type='number'] {
    width: 5.5em;
  }
`

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/** Where an entry's event is shown: the challenge, match or pairs event page */
function eventLink(kind: PointKind, id: string): string | null {
  if (kind === 'match') return `/matches/${id}`
  if (kind === 'pairs') return `/pairs/${id}`
  return `/challenges/${id}`
}

function useErrorText() {
  const { message } = usePreferences()
  return (e: unknown) => (e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
}

/** One entry: its event, the place, the points, and the corrections; admins may correct it */
function Entry({ entry, userId, admin, onChanged }: { entry: LedgerEntry; userId: string; admin: boolean; onChanged: (e: LedgerEntry) => void }) {
  const { t, lang } = usePreferences()
  const errorText = useErrorText()
  const [open, setOpen] = useState(false)
  const [points, setPoints] = useState(String(entry.points))
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const name = entry.kind === 'daily' ? t.daily.titleOn(taiwanDay(entry.at)) : t.rankings.kinds[entry.kind]
  const link = eventLink(entry.kind, entry.eventId)
  const save = async () => {
    setError('')
    try {
      const { entry: next } = await api.adjustPoints(entry.eventId, userId, Number(points), reason)
      onChanged(next)
      setOpen(false)
      setReason('')
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <li>
      <Muted as="span">{formatDate(entry.at, lang)}</Muted>
      {link ? <Link to={link}>{name}</Link> : <span>{name}</span>}
      <Muted as="span">{t.rankings.place(entry.rank, entry.field)}</Muted>
      {entry.adjustments.length > 0 && <Muted as="span">{t.rankings.base(String(entry.base))}</Muted>}
      {entry.adjustments.map((a, i) => (
        <Muted as="span" key={i}>
          {t.rankings.adjusted(signed(a.delta), a.reason)}
        </Muted>
      ))}
      <Points>{entry.points}</Points>
      {admin && !open && (
        <Button type="button" $small $variant="ghost" onClick={() => setOpen(true)}>
          {t.rankings.correct}
        </Button>
      )}
      {open && (
        <Form
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label>
            {t.rankings.correctPoints}
            <Input type="number" step="0.1" value={points} onChange={(e) => setPoints(e.target.value)} $size="sm" />
          </label>
          <label>
            {t.rankings.correctReason}
            <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} $size="sm" required />
          </label>
          <Button type="submit" $small $variant="primary">
            {t.save}
          </Button>
          <Button type="button" $small onClick={() => setOpen(false)}>
            {t.cancel}
          </Button>
          {error && <ErrorText role="alert">{error}</ErrorText>}
        </Form>
      )}
    </li>
  )
}

/** A member's entries in the period, fetched when opened */
function Ledger({ userId, name, choice, admin, onChanged }: { userId: string; name: string; choice: Choice; admin: boolean; onChanged: () => void }) {
  const { t } = usePreferences()
  const errorText = useErrorText()
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    api
      .ledger(userId, query(choice))
      .then((r) => live && setEntries(r.entries))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
    // errorText changes with the language only
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, choice])
  return (
    <div aria-label={t.rankings.ledger(name)} role="region">
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {entries && !entries.length && <Muted>{t.rankings.ledgerEmpty}</Muted>}
      {entries && entries.length > 0 && (
        <Entries>
          {entries.map((e) => (
            <Entry
              key={e.eventId}
              entry={e}
              userId={userId}
              admin={admin}
              onChanged={(next) => {
                setEntries((old) => old?.map((x) => (x.eventId === next.eventId ? next : x)) ?? null)
                onChanged()
              }}
            />
          ))}
        </Entries>
      )}
    </div>
  )
}

/** Admins: each kind's rule and the seasons */
function RulesEditor({ rules, onSaved }: { rules: PointsRules; onSaved: (rules: PointsRules) => void }) {
  const { t } = usePreferences()
  const errorText = useErrorText()
  const id = useId()
  const [kinds, setKinds] = useState(rules.kinds)
  const [seasons, setSeasons] = useState<Season[]>(rules.seasons)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const change = (kind: PointKind, patch: Partial<PointsKindRule>) => {
    setSaved(false)
    setKinds((old) => ({ ...old, [kind]: { ...old[kind], ...patch } }))
  }
  const changeSeason = (i: number, patch: Partial<Season>) => {
    setSaved(false)
    setSeasons((old) => old.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  }
  const save = async () => {
    setError('')
    try {
      const { rules: next } = await api.savePointsRules({ kinds, seasons })
      setKinds(next.kinds)
      setSeasons(next.seasons)
      setSaved(true)
      onSaved(next)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const num = (value: string) => (value === '' ? 0 : Number(value))
  return (
    <Section aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.rankings.rules}</h2>
      <Muted>{t.rankings.rulesHint}</Muted>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <RuleGrid>
          <thead>
            <tr>
              <th />
              <th>{t.rankings.enabled}</th>
              <th>{t.rankings.participation}</th>
              <th>{t.rankings.perBeaten}</th>
              <th>{t.rankings.minSides}</th>
            </tr>
          </thead>
          <tbody>
            {POINT_KINDS.map((kind) => (
              <tr key={kind}>
                <th scope="row">{t.rankings.kinds[kind]}</th>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${t.rankings.kinds[kind]} ${t.rankings.enabled}`}
                    checked={kinds[kind].enabled}
                    onChange={(e) => change(kind, { enabled: e.target.checked })}
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.1"
                    $size="sm"
                    aria-label={`${t.rankings.kinds[kind]} ${t.rankings.participation}`}
                    value={kinds[kind].participation}
                    onChange={(e) => change(kind, { participation: num(e.target.value) })}
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step="0.1"
                    $size="sm"
                    aria-label={`${t.rankings.kinds[kind]} ${t.rankings.perBeaten}`}
                    value={kinds[kind].perBeaten}
                    onChange={(e) => change(kind, { perBeaten: num(e.target.value) })}
                  />
                </td>
                <td>
                  <Input
                    type="number"
                    min={2}
                    max={100}
                    step="1"
                    $size="sm"
                    aria-label={`${t.rankings.kinds[kind]} ${t.rankings.minSides}`}
                    value={kinds[kind].minSides}
                    onChange={(e) => change(kind, { minSides: num(e.target.value) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </RuleGrid>
        <h3>{t.rankings.seasons}</h3>
        <Muted>{t.rankings.seasonsHint}</Muted>
        {seasons.map((s, i) => (
          <Form as="div" key={i}>
            <label>
              {t.rankings.seasonName}
              <Input value={s.name} maxLength={30} $size="sm" onChange={(e) => changeSeason(i, { name: e.target.value })} />
            </label>
            <label>
              {t.rankings.seasonFrom}
              <Input type="date" value={s.from} $size="sm" onChange={(e) => changeSeason(i, { from: e.target.value })} />
            </label>
            <label>
              {t.rankings.seasonTo}
              <Input type="date" value={s.to} $size="sm" onChange={(e) => changeSeason(i, { to: e.target.value })} />
            </label>
            <Button type="button" $small $variant="ghost" onClick={() => setSeasons((old) => old.filter((_, j) => j !== i))}>
              {t.rankings.removeSeason}
            </Button>
          </Form>
        ))}
        <Form as="div">
          <Button
            type="button"
            $small
            onClick={() => {
              const year = new Date().getFullYear()
              setSeasons((old) => [...old, { id: `s${Date.now().toString(36)}`, name: String(year), from: `${year}-01-01`, to: `${year}-12-31` }])
            }}
          >
            {t.rankings.addSeason}
          </Button>
          <Button type="submit" $small $variant="primary">
            {t.save}
          </Button>
          {saved && <Muted role="status">{t.saved}</Muted>}
        </Form>
        {error && <ErrorText role="alert">{error}</ErrorText>}
      </form>
    </Section>
  )
}

export function RankingsPage() {
  const { t } = usePreferences()
  const { user } = useAuth()
  const on = useFeature('rankings')
  const errorText = useErrorText()
  const [choice, setChoice] = useState<Choice>(() => ({ kind: 'month', key: taiwanMonth(Date.now()) }))
  const [board, setBoard] = useState<LeaderboardView | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let live = true
    setError('')
    api
      .rankings(query(choice))
      .then((r) => live && setBoard(r.board))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
    // errorText changes with the language only
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, version])

  if (!user) return null
  const seasons = board?.rules.seasons ?? []
  const label =
    choice.kind === 'month'
      ? t.rankings.monthLabel(choice.key)
      : choice.kind === 'year'
        ? t.rankings.yearLabel(choice.key)
        : (seasons.find((s) => s.id === choice.key)?.name ?? '')
  const step = (n: number) =>
    setChoice((c) =>
      c.kind === 'month' ? { kind: 'month', key: shiftMonth(c.key, n) } : { kind: 'year', key: String(Number(c.key) + n) },
    )

  return (
    <PageMain>
      <PageTitle>{t.rankings.title}</PageTitle>
      <Muted>{t.rankings.intro}</Muted>
      {!on && <Muted role="note">{t.rankings.offHint}</Muted>}
      {error && <ErrorText role="alert">{error}</ErrorText>}

      <Section aria-label={t.rankings.title}>
        <Bar>
          <Tabs role="group">
            <Button
              type="button"
              $small
              $variant={choice.kind === 'month' ? 'primary' : 'secondary'}
              aria-pressed={choice.kind === 'month'}
              onClick={() => setChoice({ kind: 'month', key: taiwanMonth(Date.now()) })}
            >
              {t.rankings.month}
            </Button>
            <Button
              type="button"
              $small
              $variant={choice.kind !== 'month' ? 'primary' : 'secondary'}
              aria-pressed={choice.kind !== 'month'}
              onClick={() => setChoice({ kind: 'year', key: taiwanMonth(Date.now()).slice(0, 4) })}
            >
              {t.rankings.year}
            </Button>
          </Tabs>
          {choice.kind !== 'season' && (
            <>
              <Button type="button" $small $variant="ghost" aria-label={t.rankings.prev} onClick={() => step(-1)}>
                ‹
              </Button>
              <strong data-testid="rankings-period">{label}</strong>
              <Button type="button" $small $variant="ghost" aria-label={t.rankings.next} onClick={() => step(1)}>
                ›
              </Button>
            </>
          )}
          {choice.kind !== 'month' && seasons.length > 0 && (
            <Select
              aria-label={t.rankings.seasons}
              $size="sm"
              value={choice.kind === 'season' ? choice.key : ''}
              onChange={(e) =>
                setChoice(e.target.value ? { kind: 'season', key: e.target.value } : { kind: 'year', key: taiwanMonth(Date.now()).slice(0, 4) })
              }
            >
              <option value="">{t.rankings.yearLabel(taiwanMonth(Date.now()).slice(0, 4))}</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          {choice.kind === 'season' && <strong data-testid="rankings-period">{label}</strong>}
        </Bar>
        {board && !board.rows.length && <Muted>{t.rankings.empty}</Muted>}
        {board && board.rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th className="num">{t.rankings.rankCol}</th>
                <th>{t.rankings.memberCol}</th>
                <th className="num">{t.rankings.pointsCol}</th>
                <th className="num">{t.rankings.eventsCol}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {board.rows.flatMap((row) => {
                const name = row.user ? playerName(t, row.user) : t.deletedMember
                const lines = [
                  <tr key={row.userId} aria-current={row.userId === user.id ? 'true' : undefined}>
                    <td className="num">{row.rank}</td>
                    <td>
                      <Link to={`/members/${row.userId}`}>{name}</Link>
                    </td>
                    <td className="num">{row.points}</td>
                    <td className="num">{row.events}</td>
                    <td>
                      <Button
                        type="button"
                        $small
                        $variant="ghost"
                        aria-expanded={open === row.userId}
                        onClick={() => setOpen((o) => (o === row.userId ? null : row.userId))}
                      >
                        {t.rankings.showLedger}
                      </Button>
                    </td>
                  </tr>,
                ]
                if (open === row.userId)
                  lines.push(
                    <tr key={`${row.userId}-ledger`}>
                      <td colSpan={5}>
                        <Ledger
                          userId={row.userId}
                          name={name}
                          choice={choice}
                          admin={!!user.admin}
                          onChanged={() => setVersion((v) => v + 1)}
                        />
                      </td>
                    </tr>,
                  )
                return lines
              })}
            </tbody>
          </Table>
        )}
      </Section>

      {user.admin && board && <RulesEditor rules={board.rules} onSaved={(rules) => setBoard((b) => (b ? { ...b, rules } : b))} />}
    </PageMain>
  )
}
