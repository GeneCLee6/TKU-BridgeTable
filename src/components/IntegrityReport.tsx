import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import {
  INTEGRITY_DAYS,
  INTEGRITY_LIMITS,
  type IntegrityDays,
  type IntegrityLevel,
  type IntegrityPair,
  type IntegrityReport as Report,
} from '../../shared/integrity.ts'
import { api, ApiError } from '../lib/api.ts'
import { formatDate, formatDateTime } from '../lib/format.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, ErrorText, Field, FieldLabel, Muted, Select } from './ui.tsx'

/**
 * The admin page's anti-cheating report (`e11-t25`, ARCHITECTURE.md §5.17): accounts seen on one
 * browser or one small network, and what they played together. Read only when the admin asks, not
 * every time the admin page opens; a lead to look into, never a verdict
 */
export function IntegrityReport() {
  const { t, lang, message } = usePreferences()
  const g = t.integrity
  const id = useId()
  const [days, setDays] = useState<IntegrityDays>(INTEGRITY_DAYS[0])
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      setReport((await api.admin.integrity(days)).report)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : t.genericError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Body>
      <Controls>
        <Field>
          <FieldLabel htmlFor={`${id}-days`}>{g.days}</FieldLabel>
          <Select id={`${id}-days`} value={days} onChange={(e) => setDays(Number(e.target.value) as IntegrityDays)}>
            {[...INTEGRITY_DAYS].sort((a, b) => a - b).map((n) => (
              <option key={n} value={n}>
                {g.daysOption(n)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="button" $variant="primary" $busy={busy} onClick={() => void run()}>
          {g.run}
        </Button>
      </Controls>
      <Muted>{g.caution}</Muted>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {report && (
        <>
          {report.networkOff && <Muted>{g.networkOff}</Muted>}
          <Summary aria-live="polite">
            {g.summary(report.seen, report.pairs.length)}
            {report.more > 0 && ` ${g.more(report.more)}`}
          </Summary>
          {report.pairs.length === 0 ? (
            <Muted>{g.none}</Muted>
          ) : (
            <Pairs aria-label={g.title}>
              {report.pairs.map((pair) => (
                <PairItem key={`${pair.a.id}-${pair.b.id}`} pair={pair} />
              ))}
            </Pairs>
          )}
          {report.shared.length > 0 && (
            <Shared>
              <SharedTitle>{g.sharedTitle}</SharedTitle>
              <Muted>{g.sharedHint(INTEGRITY_LIMITS.sharedNetwork)}</Muted>
              <ul>
                {report.shared.map((net) => (
                  <li key={net.label}>
                    {g.sharedRow(net.label, net.members)} · {g.lastSeen(formatDate(net.lastSeen, lang))}
                  </li>
                ))}
              </ul>
            </Shared>
          )}
        </>
      )}
    </Body>
  )
}

/** One pair of accounts: what links them and what they played together */
function PairItem({ pair }: { pair: IntegrityPair }) {
  const { t, lang } = usePreferences()
  const g = t.integrity
  const name = (side: 'a' | 'b') => pair[side].username
  return (
    <Pair $level={pair.level}>
      <PairHead>
        <strong>
          <Link to={`/members/${pair.a.id}`}>{pair.a.username}</Link>
          {' · '}
          <Link to={`/members/${pair.b.id}`}>{pair.b.username}</Link>
        </strong>
        <Level $level={pair.level}>{g.levelLabel(g.levels[pair.level])}</Level>
      </PairHead>
      <Facts>
        {pair.devices.length > 0 && <li>{g.sameDevice(pair.devices.map((d) => d || g.unknownDevice).join('、'))}</li>}
        {pair.networks > 0 && <li>{g.sameNetwork(pair.networks)}</li>}
        <li>{pair.partners + pair.opponents > 0 ? g.played(pair.partners, pair.opponents) : g.notTogether}</li>
        {pair.boards.length > 0 && (
          <li>
            {g.recentBoards}
            {t.colon}
            {pair.boards.map((board, i) => (
              <span key={board}>
                {i > 0 && '、'}
                <Link to={`/history/${board}`}>{g.boardLink(i + 1)}</Link>
              </span>
            ))}
          </li>
        )}
        {pair.events.map((event) => (
          <li key={event.id}>
            <Link to={event.mode === 'team' ? `/matches/${event.id}` : `/challenges/${event.id}`}>
              {event.mode === 'team' ? g.team : g.challenge} {formatDate(event.at, lang)}
            </Link>
            {event.after && ` · ${g.after(name(event.after))}`}
          </li>
        ))}
        <li>{g.lastSeen(formatDateTime(pair.lastSeen, lang))}</li>
      </Facts>
    </Pair>
  )
}

const Body = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
`

const Controls = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: ${({ theme }) => theme.space(3)};

  & > div {
    flex: 0 1 200px;
  }
`

const Summary = styled.p`
  margin: 0;
  font-weight: 600;
`

const Pairs = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: ${({ theme }) => theme.space(3)};
`

const Pair = styled.li<{ $level: IntegrityLevel }>`
  padding: ${({ theme }) => theme.space(3)};
  border: 1px solid ${({ theme, $level }) => ($level === 'high' ? theme.colors.danger : theme.colors.border)};
  border-radius: ${({ theme }) => theme.radius.md};
`

const PairHead = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: ${({ theme }) => theme.space(2)};
`

const Level = styled.span<{ $level: IntegrityLevel }>`
  padding: 2px ${({ theme }) => theme.space(2)};
  border-radius: ${({ theme }) => theme.radius.md};
  font-size: ${({ theme }) => theme.type.caption.size};
  background: ${({ theme, $level }) =>
    $level === 'high' ? theme.colors.dangerSoft : $level === 'medium' ? theme.colors.accentSoft : theme.colors.surfaceAlt};
  color: ${({ theme, $level }) => ($level === 'high' ? theme.colors.danger : theme.colors.text)};
`

const Facts = styled.ul`
  margin: ${({ theme }) => theme.space(2)} 0 0;
  padding-left: ${({ theme }) => theme.space(5)};
  display: grid;
  gap: ${({ theme }) => theme.space(1)};
  font-size: 14px;
`

const Shared = styled.div`
  display: grid;
  gap: ${({ theme }) => theme.space(1)};

  ul {
    margin: 0;
    padding-left: ${({ theme }) => theme.space(5)};
    font-size: 14px;
  }
`

const SharedTitle = styled.h3`
  margin: 0;
  font-size: 15px;
`
