import { X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import styled from 'styled-components'
import {
  CHALLENGE_LIMITS,
  defaultChallengeSettings,
  RANKING_VISIBILITIES,
  scoringsFor,
  type ChallengeSettings,
  type ChallengeView,
} from '../../shared/challenge.ts'
import { robotKindsFor, type PublicUser, type RobotKind } from '../../shared/protocol.ts'
import { ApiError, api } from '../lib/api.ts'
import { formatDateTime } from '../lib/format.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, ErrorText, Muted } from './ui.tsx'

/**
 * 發起挑戰 (`e7-t17`, AC-7.1): pick friends from a searchable box (a click lists them all, typing
 * filters after a short pause), choose the settings, see a preview, send. Only friends can be
 * picked, and the deals are random, with Best Hand and Just Declare as options (`e7-t10`, `e7-t11`);
 * the server checks it all again (ARCHITECTURE.md §5.5). Opened from a board's record with
 * `fromBoards` it is 「用這副牌挑戰」 (`e7-t22`): those boards, the robots of then, no deal options.
 * Only a member who may use the club's system (`tkuSystem`) chooses the robots; for anyone else
 * there is one TKB, the 2/1 one (ROBOT.md §7).
 */

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
  width: 100%;
  max-width: 480px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 ${({ theme }) => theme.space(3)};
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Field = styled.div`
  display: grid;
  gap: 6px;
  margin-bottom: ${({ theme }) => theme.space(4)};

  & > label, & > span { font-weight: 700; }
`

const Row = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
`

const Select = styled.select`
  min-height: 40px;
  padding: 0 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  color: ${({ theme }) => theme.colors.text};
  font-size: 15px;
`

const Picker = styled.div`
  position: relative;
`

const Box = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};

  & > input {
    flex: 1 1 120px;
    min-width: 0;
    min-height: 30px;
    border: 0;
    outline: 0;
    background: transparent;
    color: ${({ theme }) => theme.colors.text};
    font-size: 15px;
  }
`

const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 10px;
  border-radius: 999px;
  background: ${({ theme }) => theme.colors.primarySoft};
  color: ${({ theme }) => theme.colors.primaryStrong};
  font-size: 14px;
  font-weight: 600;

  & > button {
    display: inline-flex;
    padding: 2px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: inherit;
  }
`

const Options = styled.ul`
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 1;
  max-height: 220px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};
`

const Option = styled.li<{ $active: boolean }>`
  padding: 8px 10px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme, $active }) => ($active ? theme.colors.primarySoft : 'transparent')};
  cursor: pointer;
`

const Choice = styled.label`
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  align-items: start;
  margin-bottom: ${({ theme }) => theme.space(2)};
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  border: 1px solid ${({ theme }) => theme.colors.border};
  background: ${({ theme }) => theme.colors.surfaceAlt};
  cursor: pointer;

  & > input { margin: 3px 0 0; }
  & > span { font-weight: 600; }
  & > p { grid-column: 2; margin: 0; }
`

const Preview = styled.div`
  display: grid;
  gap: 6px;
  margin-bottom: ${({ theme }) => theme.space(4)};
  padding: 10px 12px;
  border-radius: ${({ theme }) => theme.radius.sm};
  background: ${({ theme }) => theme.colors.surfaceAlt};

  & > strong { font-size: 14px; }
`

const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: ${({ theme }) => theme.space(3)};
`

/** The value after it stopped changing for `ms`: the friend filter waits for a pause in typing */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

export function ChallengeDialog({
  onClose,
  onCreated,
  fromBoards,
}: {
  onClose: () => void
  onCreated: (c: ChallengeView) => void
  /** 「用這副牌挑戰」: the boards from the history and the robots they were played with */
  fromBoards?: { ids: string[]; robotKind: RobotKind }
}) {
  const { t, lang, message } = usePreferences()
  const { lobby } = useClub()
  const { user } = useAuth()
  const robotKinds = robotKindsFor(user)
  const titleId = useId()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)

  const friends: PublicUser[] = useMemo(() => {
    const ids = new Set(lobby?.friends ?? [])
    return (lobby?.members ?? []).filter((m) => ids.has(m.id) && !m.robot)
  }, [lobby])
  const [picked, setPicked] = useState<PublicUser[]>([])
  const [query, setQuery] = useState('')
  const typed = useDebounced(query.trim().toLowerCase(), 150)
  // Clearing the box (or picking someone) shows everyone at once
  const filter = query.trim() ? typed : ''
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const [boards, setBoards] = useState<number>(CHALLENGE_LIMITS.boardsDefault)
  const [settings, setSettings] = useState<Omit<ChallengeSettings, 'scoring'> & { scoring?: ChallengeSettings['scoring'] }>(
    () => ({ ...defaultChallengeSettings(1), scoring: undefined }),
  )
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // The preview's deadline counts from when the dialog opened; the server counts from sending
  const [openedAt] = useState(() => Date.now())

  const max = CHALLENGE_LIMITS.invitedMax
  const choices = friends.filter((f) => !picked.some((p) => p.id === f.id) && f.username.toLowerCase().includes(filter))
  // The scoring choices depend on how many are invited; a choice that no longer fits falls back
  const scorings = scoringsFor(Math.max(1, picked.length))
  const scoring =
    settings.scoring && scorings.includes(settings.scoring) ? settings.scoring : defaultChallengeSettings(Math.max(1, picked.length)).scoring

  useEffect(() => input.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const pick = (friend: PublicUser) => {
    if (picked.length >= max) return
    setPicked([...picked, friend])
    setQuery('')
    setActive(0)
    input.current?.focus()
  }

  const submit = async () => {
    if (!picked.length) {
      setError(t.pickFriends)
      return
    }
    setSending(true)
    setError('')
    try {
      const ids = picked.map((p) => p.id)
      const { robotKind: kind, bestHand, justDeclare, days, ranking } = settings
      const { challenge } = fromBoards
        ? await api.challengeWithBoards(ids, fromBoards.ids, { scoring, days, ranking })
        : await api.createChallenge(ids, boards, { scoring, robotKind: kind, bestHand, justDeclare, days, ranking })
      onCreated(challenge)
    } catch (e) {
      setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e))
      setSending(false)
    }
  }

  const deadline = formatDateTime(openedAt + settings.days * 86_400_000, lang)
  const boardCount = fromBoards ? fromBoards.ids.length : boards
  const robotKind = fromBoards?.robotKind ?? settings.robotKind

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{fromBoards ? t.challengeWithBoard : t.newChallenge}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Field>
            <label htmlFor={`${listId}-input`}>{t.challengeFriends}</label>
            <Picker>
              <Box onClick={() => input.current?.focus()}>
                {picked.map((p) => (
                  <Chip key={p.id}>
                    {p.username}
                    <button
                      type="button"
                      aria-label={t.removeInvitee(p.username)}
                      onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}
                    >
                      <X size={14} aria-hidden />
                    </button>
                  </Chip>
                ))}
                <input
                  ref={input}
                  id={`${listId}-input`}
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  placeholder={t.challengeFriendsSearch}
                  value={query}
                  autoComplete="off"
                  onFocus={() => setOpen(true)}
                  onClick={() => setOpen(true)}
                  onBlur={() => setOpen(false)}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setActive(0)
                    setOpen(true)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setOpen(true)
                      setActive((i) => Math.min(i + 1, choices.length - 1))
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActive((i) => Math.max(i - 1, 0))
                    } else if (event.key === 'Enter' && open && choices[active]) {
                      event.preventDefault()
                      pick(choices[active])
                    } else if (event.key === 'Backspace' && !query && picked.length) {
                      setPicked(picked.slice(0, -1))
                    }
                  }}
                />
              </Box>
              {open && (
                <Options id={listId} role="listbox" aria-label={t.challengeFriends}>
                  {choices.length ? (
                    choices.map((f, i) => (
                      <Option
                        key={f.id}
                        role="option"
                        aria-selected={i === active}
                        $active={i === active}
                        // Before the input's blur closes the list
                        onMouseDown={(event) => {
                          event.preventDefault()
                          pick(f)
                        }}
                      >
                        {f.username}
                      </Option>
                    ))
                  ) : (
                    <Option $active={false} aria-disabled>
                      <Muted as="span">{friends.length ? t.noFriendMatches : t.noFriendsToInvite}</Muted>
                    </Option>
                  )}
                </Options>
              )}
            </Picker>
            <Muted>{t.challengeFriendsHint(max)}</Muted>
          </Field>

          <Row>
            {!fromBoards && (
              <Field>
                <label htmlFor={`${listId}-boards`}>{t.challengeBoardsLabel}</label>
                <Select id={`${listId}-boards`} value={boards} onChange={(e) => setBoards(Number(e.target.value))}>
                  {range(CHALLENGE_LIMITS.boardsMin, CHALLENGE_LIMITS.boardsMax).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field>
              <label htmlFor={`${listId}-scoring`}>{t.challengeScoring}</label>
              <Select
                id={`${listId}-scoring`}
                value={scoring}
                onChange={(e) => setSettings({ ...settings, scoring: e.target.value as ChallengeSettings['scoring'] })}
              >
                {scorings.map((s) => (
                  <option key={s} value={s}>
                    {t.scorings[s]}
                  </option>
                ))}
              </Select>
            </Field>
            {robotKinds.length > 1 && (
            <Field>
              <label htmlFor={`${listId}-robots`}>{t.challengeRobots}</label>
              <Select
                id={`${listId}-robots`}
                value={robotKind}
                // 「用這副牌挑戰」 keeps the robots the boards were played with
                disabled={!!fromBoards}
                onChange={(e) => setSettings({ ...settings, robotKind: e.target.value as ChallengeSettings['robotKind'] })}
              >
                {robotKinds.map((k) => (
                  <option key={k} value={k}>
                    {t.robots[k]}
                  </option>
                ))}
              </Select>
            </Field>
            )}
            <Field>
              <label htmlFor={`${listId}-days`}>{t.challengeDays}</label>
              <Select
                id={`${listId}-days`}
                value={settings.days}
                onChange={(e) => setSettings({ ...settings, days: Number(e.target.value) })}
              >
                {range(CHALLENGE_LIMITS.daysMin, CHALLENGE_LIMITS.daysMax).map((n) => (
                  <option key={n} value={n}>
                    {t.challengeDaysOption(n)}
                  </option>
                ))}
              </Select>
            </Field>
          </Row>
          <Field>
            <label htmlFor={`${listId}-ranking`}>{t.challengeRanking}</label>
            <Select
              id={`${listId}-ranking`}
              value={settings.ranking}
              onChange={(e) => setSettings({ ...settings, ranking: e.target.value as ChallengeSettings['ranking'] })}
            >
              {RANKING_VISIBILITIES.map((r) => (
                <option key={r} value={r}>
                  {t.rankingVisibilities[r]}
                </option>
              ))}
            </Select>
          </Field>

          {!fromBoards && (
            <>
              <Choice>
                <input
                  type="checkbox"
                  checked={settings.bestHand}
                  onChange={(e) => setSettings({ ...settings, bestHand: e.target.checked })}
                />
                <span>{t.bestHand}</span>
                <Muted>{t.bestHandHint}</Muted>
              </Choice>
              <Choice>
                <input
                  type="checkbox"
                  checked={settings.justDeclare}
                  onChange={(e) => setSettings({ ...settings, justDeclare: e.target.checked })}
                />
                <span>{t.justDeclare}</span>
                <Muted>{t.justDeclareHint}</Muted>
              </Choice>
            </>
          )}

          <Preview aria-label={t.challengePreview}>
            <strong>{t.challengePreview}</strong>
            <span data-testid="challenge-preview">
              {[
                t.challengePreviewText(picked.length, boardCount, t.scorings[scoring], t.robots[robotKind], deadline),
                !fromBoards && settings.bestHand && t.bestHand,
                !fromBoards && settings.justDeclare && t.justDeclare,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            <Muted>{fromBoards ? t.challengeWithBoardHint(t.robots[robotKind]) : t.challengeRules}</Muted>
          </Preview>

          {error && <ErrorText role="alert">{error}</ErrorText>}
          <Buttons>
            <Button type="button" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" $variant="primary" disabled={sending}>
              {t.sendChallenge}
            </Button>
          </Buttons>
        </form>
      </Panel>
    </Backdrop>
  )
}
