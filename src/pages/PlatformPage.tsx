import { useCallback, useEffect, useId, useState } from 'react'
import styled from 'styled-components'
import type { ClubApplicationView, PlatformClub, PlatformView } from '../../shared/platform.ts'
import { PlatformNotices, PlatformSupport } from '../components/PlatformNotices.tsx'
import { useToast } from '../components/Toast.tsx'
import { Button, Card, CardHeader, CardTitle, ErrorText, Field, FieldLabel, Input, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { api, ApiError } from '../lib/api.ts'
import { formatBytes } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * 平台後台 (e12-t05, `/platform`): only for the platform owner (`Me.platformOwner`; the server
 * checks again on every request, worker/platform.ts `requirePlatformOwner`). Every club with its
 * usage and admins, suspending and serving one again, and the applications to open one (e12-t06)
 */

const Stack = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(4)};
  width: min(100%, 1100px);
`

const Stats = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;

  div {
    padding: ${({ theme }) => theme.space(2)};
    border: 1px solid ${({ theme }) => theme.colors.border};
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.surfaceAlt};
  }
  dt {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: 13px;
  }
  dd {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
`

const Scroll = styled.div`
  overflow-x: auto;
`

const Table = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;

  th,
  td {
    padding: 8px;
    border-bottom: 1px solid ${({ theme }) => theme.colors.border};
    text-align: left;
    vertical-align: top;
  }
  th {
    color: ${({ theme }) => theme.colors.textMuted};
    font-weight: 600;
  }
  .num {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
`

const Badge = styled.span<{ $tone: 'good' | 'bad' | 'wait' }>`
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 13px;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $tone }) =>
    $tone === 'good' ? theme.colors.successSoft : $tone === 'bad' ? theme.colors.dangerSoft : theme.colors.accentSoft};
`

const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${({ theme }) => theme.space(2)};
  align-items: end;
`

const Application = styled.article`
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(3)} 0;
  border-bottom: 1px solid ${({ theme }) => theme.colors.border};

  h3 {
    margin: 0;
    font-size: 16px;
  }
  p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`

export function PlatformPage() {
  const { t, message } = usePreferences()
  const p = t.platform
  const toast = useToast()
  const [view, setView] = useState<PlatformView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const failed = useCallback(
    (err: unknown) => (err instanceof ApiError ? message(err.code, err.params, err.message) : t.genericError),
    [message, t.genericError],
  )

  useEffect(() => {
    let cancelled = false
    api.platform.view().then(
      (v) => !cancelled && setView(v),
      (err: unknown) => !cancelled && setError(failed(err)),
    )
    return () => {
      cancelled = true
    }
  }, [failed])

  /** Runs an action; its answer is the whole view again */
  const run = async (key: string, action: () => Promise<PlatformView>, done: string) => {
    setBusy(key)
    try {
      setView(await action())
      toast.success(done)
      return true
    } catch (err) {
      toast.error(failed(err))
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageMain>
      <PageTitle>{p.title}</PageTitle>
      <Stack>
        <Muted>{p.intro}</Muted>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        {!view && !error && <Muted>{t.loading}</Muted>}
        {view && (
          <>
            <Card aria-labelledby="platform-totals">
              <CardHeader>
                <CardTitle id="platform-totals">{p.totals}</CardTitle>
              </CardHeader>
              <Stats>
                <div>
                  <dt>{p.clubs}</dt>
                  <dd>{view.clubs.length}</dd>
                </div>
                <div>
                  <dt>{p.members}</dt>
                  <dd>{view.totals.members}</dd>
                </div>
                <div>
                  <dt>{p.storage}</dt>
                  <dd>{formatBytes(view.totals.storageBytes)}</dd>
                </div>
                <div>
                  <dt>{p.files}</dt>
                  <dd>{formatBytes(view.totals.filesBytes)}</dd>
                </div>
                <div>
                  <dt>{p.backups}</dt>
                  <dd>{formatBytes(view.totals.backupBytes)}</dd>
                </div>
                <div>
                  <dt>{p.rows}</dt>
                  <dd>{p.rowsCount(view.totals.historyRows)}</dd>
                </div>
              </Stats>
            </Card>

            <Card aria-labelledby="platform-clubs">
              <CardHeader>
                <CardTitle id="platform-clubs">{p.clubs}</CardTitle>
              </CardHeader>
              <Scroll>
                <Table aria-label={p.clubs}>
                  <thead>
                    <tr>
                      <th>{p.id}</th>
                      <th>{p.name}</th>
                      <th>{p.status}</th>
                      <th>{p.usage}</th>
                      <th>{p.admins}</th>
                      <th>{p.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.clubs.map((club) => (
                      <ClubRow key={club.id} club={club} busy={busy} run={run} />
                    ))}
                  </tbody>
                </Table>
              </Scroll>
            </Card>

            <Card aria-labelledby="platform-apps">
              <CardHeader>
                <CardTitle id="platform-apps">{p.apps}</CardTitle>
              </CardHeader>
              {!view.applications.length ? (
                <Muted>{p.noApps}</Muted>
              ) : (
                view.applications.map((a) => <ApplicationItem key={a.id} application={a} busy={busy} run={run} />)
              )}
            </Card>

            <PlatformNotices view={view} busy={busy} run={run} />
            <PlatformSupport view={view} busy={busy} run={run} />
          </>
        )}
      </Stack>
    </PageMain>
  )
}

type Run = (key: string, action: () => Promise<PlatformView>, done: string) => Promise<boolean>

function ClubRow({ club, busy, run }: { club: PlatformClub; busy: string | null; run: Run }) {
  const { t } = usePreferences()
  const p = t.platform
  const id = useId()
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const u = club.usage
  const suspended = club.status === 'suspended'
  return (
    <tr>
      <td>
        <code>{club.id}</code>
      </td>
      <td>
        {club.name}
        {club.organisation && <Muted as="div">{club.organisation}</Muted>}
        {club.contactEmail && <Muted as="div">{club.contactEmail}</Muted>}
      </td>
      <td>
        <Badge $tone={suspended ? 'bad' : 'good'}>{suspended ? p.suspended : p.active}</Badge>
      </td>
      <td className="num">
        {u ? (
          <>
            <div>{`${p.members} ${u.members} · ${p.tables} ${u.tables} · ${p.boards} ${u.boards}`}</div>
            <div>{`${p.storage} ${formatBytes(u.storageBytes)}`}</div>
            <div>{`${p.files} ${formatBytes(u.filesBytes)}`}</div>
            <div>{`${p.backups} ${u.backupBytes === null ? p.none : formatBytes(u.backupBytes)}`}</div>
            <div>{`${p.rows} ${u.historyRows === null ? p.none : p.rowsCount(u.historyRows)}`}</div>
          </>
        ) : (
          p.noUsage
        )}
      </td>
      <td>{u ? u.admins.map((a) => a.username).join(', ') || p.none : p.none}</td>
      <td>
        {club.id === 'tku' ? (
          p.none
        ) : suspended ? (
          <Button
            type="button"
            $size="sm"
            $busy={busy === `status-${club.id}`}
            onClick={() => void run(`status-${club.id}`, () => api.platform.setStatus(club.id, 'active', ''), p.unsuspendedToast(club.id))}
          >
            {p.unsuspend}
          </Button>
        ) : asking ? (
          <Row>
            <Muted as="div">{p.suspendConfirm(club.name)}</Muted>
            <Field>
              <FieldLabel htmlFor={`${id}-note`}>{p.note}</FieldLabel>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} $size="sm" />
            </Field>
            <Button
              type="button"
              $size="sm"
              $variant="danger"
              $busy={busy === `status-${club.id}`}
              onClick={async () => {
                if (await run(`status-${club.id}`, () => api.platform.setStatus(club.id, 'suspended', note), p.suspendedToast(club.id))) setAsking(false)
              }}
            >
              {p.suspend}
            </Button>
            <Button type="button" $size="sm" onClick={() => setAsking(false)}>
              {p.cancel}
            </Button>
          </Row>
        ) : (
          <Button type="button" $size="sm" $variant="danger" onClick={() => setAsking(true)}>
            {p.suspend}
          </Button>
        )}
      </td>
    </tr>
  )
}

function ApplicationItem({ application: a, busy, run }: { application: ClubApplicationView; busy: string | null; run: Run }) {
  const { t, lang } = usePreferences()
  const p = t.platform
  const id = useId()
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const status = a.status === 'pending' ? p.pending : a.status === 'approved' ? p.approved : p.rejected
  return (
    <Application aria-labelledby={`${id}-title`}>
      <Row>
        <h3 id={`${id}-title`}>
          {a.name} <code>{a.clubId}</code>
        </h3>
        <Badge $tone={a.status === 'approved' ? 'good' : a.status === 'rejected' ? 'bad' : 'wait'}>{status}</Badge>
        <Muted as="span">{new Date(a.createdAt).toLocaleString(lang)}</Muted>
      </Row>
      <Muted as="div">{a.organisation}</Muted>
      <Muted as="div">{p.applicant(a.username, a.contactEmail)}</Muted>
      <p>{a.reason}</p>
      {a.note && <p>{a.note}</p>}
      {a.status === 'pending' &&
        (rejecting ? (
          <Row>
            <Field>
              <FieldLabel htmlFor={`${id}-note`}>{p.rejectNote}</FieldLabel>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} $size="sm" />
            </Field>
            <Button
              type="button"
              $size="sm"
              $variant="danger"
              $busy={busy === `reject-${a.id}`}
              onClick={() => void run(`reject-${a.id}`, () => api.platform.reject(a.id, note), p.rejectedToast(a.clubId))}
            >
              {p.confirmReject}
            </Button>
            <Button type="button" $size="sm" onClick={() => setRejecting(false)}>
              {p.cancel}
            </Button>
          </Row>
        ) : (
          <Row>
            <Button
              type="button"
              $size="sm"
              $variant="primary"
              $busy={busy === `approve-${a.id}`}
              onClick={() => void run(`approve-${a.id}`, () => api.platform.approve(a.id), p.approvedToast(a.clubId))}
            >
              {p.approve}
            </Button>
            <Button type="button" $size="sm" onClick={() => setRejecting(true)}>
              {p.reject}
            </Button>
          </Row>
        ))}
    </Application>
  )
}
