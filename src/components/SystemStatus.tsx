import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'
import type { HealthStatus } from '../../shared/protocol.ts'
import { api } from '../lib/api.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, ErrorText, Muted } from './ui.tsx'

/** How often the open admin page reads `/api/health` again (one Worker and one club request each) */
const REFRESH_MS = 30_000

/**
 * The admin page's system status (e11-t22, ARCHITECTURE.md §5.13): `/api/health` as numbers and
 * the warnings it gives. Counts only; it is the same answer an outside monitor would get
 */
export function SystemStatus() {
  const { t } = usePreferences()
  const [status, setStatus] = useState<HealthStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  // Only ever sets state once the answer is in, so it can run from the effect
  const read = useCallback(
    () =>
      api
        .health()
        .then((next) => {
          setStatus(next)
          setFailed(false)
        })
        .catch(() => setFailed(true)),
    [],
  )
  const refresh = () => {
    setBusy(true)
    void read().finally(() => setBusy(false))
  }

  useEffect(() => {
    void read()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void read()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [read])

  const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.01 ? 2 : 1)}%`
  const m = status?.metrics
  const items: [string, string][] = status && m
    ? [
        [t.statusOnline, String(status.online)],
        [t.statusTables, String(status.tables)],
        [t.statusPlaying, String(status.playing)],
        [t.statusRobots, String(status.robots)],
        [t.statusBoards, String(m.boards)],
        [t.statusActions, String(m.actions)],
        [t.statusActionP95, m.actionP95Ms === null ? t.statusNone : `≤ ${t.statusMs(m.actionP95Ms)}`],
        [t.statusErrorRate, pct(m.errorRate)],
        [t.statusReconnectRate, pct(m.reconnectRate)],
        [
          t.statusRobotThink,
          m.robot.avgMs === null ? t.statusNone : `${t.statusMs(m.robot.avgMs)} / ${t.statusMs(m.robot.maxMs ?? 0)}`,
        ],
        ...(status.events ? ([[t.statusEvents, String(status.events.objects)]] as [string, string][]) : []),
      ]
    : []

  return (
    <>
      <Top>
        <Muted>{m ? t.statusWindow(m.minutes) : t.loading}</Muted>
        <Button type="button" $size="sm" $busy={busy} onClick={refresh}>
          <RefreshCw size={14} aria-hidden />
          {t.statusRefresh}
        </Button>
      </Top>
      {failed && <ErrorText role="alert">{t.statusFailed}</ErrorText>}
      {status && (
        <>
          <Alerts aria-live="polite">
            {status.alerts.length === 0 ? (
              <Good>{t.statusOk}</Good>
            ) : (
              status.alerts.map((alert) => <Bad key={alert}>{t.statusAlerts[alert]}</Bad>)
            )}
          </Alerts>
          <Grid>
            {items.map(([label, value]) => (
              <Item key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </Item>
            ))}
          </Grid>
        </>
      )}
    </>
  )
}

const Top = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(3)};
  margin-bottom: ${({ theme }) => theme.space(3)};
`

const Alerts = styled.ul`
  list-style: none;
  margin: 0 0 ${({ theme }) => theme.space(3)};
  padding: 0;
  display: grid;
  gap: ${({ theme }) => theme.space(2)};
`

const Note = styled.li`
  padding: ${({ theme }) => theme.space(2)} ${({ theme }) => theme.space(3)};
  border-radius: ${({ theme }) => theme.radius.md};
  font-size: 14px;
`

const Good = styled(Note)`
  background: ${({ theme }) => theme.colors.successSoft};
  color: ${({ theme }) => theme.colors.success};
`

const Bad = styled(Note)`
  background: ${({ theme }) => theme.colors.dangerSoft};
  color: ${({ theme }) => theme.colors.danger};
`

const Grid = styled.dl`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: ${({ theme }) => theme.space(3)};
  margin: 0;
`

const Item = styled.div`
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.md};

  dt {
    color: ${({ theme }) => theme.colors.textMuted};
    font-size: ${({ theme }) => theme.type.caption.size};
  }
  dd {
    margin: ${({ theme }) => theme.space(1)} 0 0;
    font-size: 20px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
`
