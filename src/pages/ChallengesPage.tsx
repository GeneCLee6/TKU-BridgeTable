import { CalendarClock, Plus, Swords } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router-dom'
import styled from 'styled-components'
import type { ChallengeView } from '../../shared/challenge.ts'
import { ChallengeDialog } from '../components/ChallengeDialog.tsx'
import { Chip, ChipCount, ChipStrip } from '../components/Chips.tsx'
import { PlayerGrid, Progress, StatusTag } from '../components/ChallengeParts.tsx'
import { Pager, SortSelect } from '../components/Pager.tsx'
import { WeeklyChallengeDialog } from '../components/WeeklyChallengeDialog.tsx'
import { Button, Card, ErrorText, Muted, PageMain, PageTitle } from '../components/ui.tsx'
import { ApiError, api } from '../lib/api.ts'
import {
  CHALLENGE_TABS,
  challengeTitle,
  challengeTab,
  playerOf,
  settingsBase,
  settingsOptions,
  timeLeft,
  type ChallengeTab,
} from '../lib/challenges.ts'
import { formatDateTime } from '../lib/format.ts'
import { LIST_SORTS, paginate, sortList } from '../lib/lists.ts'
import { useListParams } from '../lib/useListParams.ts'
import { useAuth } from '../state/AuthContext.tsx'
import { cardHover } from '../styles/controls.ts'
import { useClub } from '../state/ClubContext.tsx'
import { usePreferences } from '../state/PreferencesContext.tsx'

/**
 * The challenge lobby (`e7-t16`, AC-7.7): 等待接受, 進行中 and 已完成, each challenge a small card
 * in a grid with its state, the time left, the member's own progress and the other participants
 * side by side (a challenge can have ~20). The whole card opens the challenge's page (`e7-t18`),
 * where it is answered, played and called off; the list sorts and pages like every list of
 * records (`Pager`, 社長 2026-10-27). Starting a new challenge (`e7-t17`) is here.
 */

/** Participants a card shows before 「還有 N 人」 */
const CARD_PLAYERS = 6

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;

  & > h1 {
    margin: 0;
  }
`

const ListTools = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  margin-bottom: 16px;

  /* The tabs take the row and scroll inside it; the sort menu stays at the right */
  & > :first-child {
    flex: 1 1 320px;
  }
  & > :last-child {
    margin-left: auto;
  }
`

const Grid = styled.ul`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
`

/** The whole card is the link; pointing at it or focusing it glows gold (`cardHover`, DESIGN.md §5.3) */
const CardLink = styled(Link)`
  display: grid;
  align-content: start;
  gap: 8px;
  height: 100%;
  padding: 12px 14px;
  border: 1px solid ${({ theme }) => theme.colors.border};
  border-radius: ${({ theme }) => theme.radius.lg};
  background: ${({ theme }) => theme.colors.surface};
  box-shadow: ${({ theme }) => theme.shadow};
  color: ${({ theme }) => theme.colors.text};
  text-decoration: none;
  ${cardHover()}
`

const Head = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

  & > strong {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: ${({ theme }) => theme.colors.primaryStrong};
    font-size: 16px;
  }
`

const Small = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 2px 10px;
  color: ${({ theme }) => theme.colors.textMuted};
  font-size: 13px;
  line-height: 18px;
`

/** Best Hand, Just Declare: tags on a line of their own under the settings */
const Options = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;

  & > span {
    padding: 0 8px;
    border-radius: ${({ theme }) => theme.radius.sm};
    background: ${({ theme }) => theme.colors.accentSoft};
    color: ${({ theme }) => theme.colors.accentStrong};
    font-size: ${({ theme }) => theme.type.caption.size};
    line-height: 20px;
    font-weight: 600;
    white-space: nowrap;
  }
`

const Mine = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
`

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`

function ChallengeCard({ c, userId, now }: { c: ChallengeView; userId: string; now: number }) {
  const { t, lang } = usePreferences()
  const id = useId()
  const me = playerOf(c, userId)
  const title = challengeTitle(t, c)
  const others = c.players.filter((p) => p.userId !== userId)
  const open = c.status === 'pending' || c.status === 'active'
  const options = settingsOptions(t, c)
  return (
    <li aria-label={title}>
      <CardLink
        to={`/challenges/${c.id}`}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-details`}
      >
        <Head>
          <StatusTag status={c.status} />
          <strong id={`${id}-title`}>{title}</strong>
        </Head>
        <div id={`${id}-details`}>
          <Small>
            <span>{settingsBase(t, c)}</span>
            <span title={t.challengeDeadline(formatDateTime(c.deadline, lang))}>
              {open && now < c.deadline
                ? timeLeft(t, c.deadline - now)
                : t.challengeEndedAt(formatDateTime(c.endedAt ?? c.deadline, lang))}
            </span>
          </Small>
          {options.length > 0 && (
            <Options>
              {options.map((o) => (
                <span key={o}>{o}</span>
              ))}
            </Options>
          )}
          {me?.status === 'accepted' && (
            <Mine>
              <span>{t.challengeYourProgress}</span>
              <Progress played={me.played} boards={c.boards} label={t.challengeYourProgress} />
            </Mine>
          )}
        </div>
        {others.length > 0 && (
          <PlayerGrid players={others} boards={c.boards} compact max={CARD_PLAYERS} />
        )}
      </CardLink>
    </li>
  )
}

export function ChallengesPage() {
  const { t, message } = usePreferences()
  const { user } = useAuth()
  const { notifications } = useClub()
  const [list, setList] = useState<ChallengeView[] | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<ChallengeTab | null>(null)
  const [creating, setCreating] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const listing = useListParams(LIST_SORTS, 'newest')

  // A new notification (an answer, a reminder, the results) may change the list
  const latest = notifications?.items[0]?.id
  useEffect(() => {
    let live = true
    api
      .challenges()
      .then((r) => {
        if (!live) return
        setList(r.challenges)
        setNow(Date.now())
      })
      .catch(
        (e) =>
          live &&
          setError(e instanceof ApiError ? message(e.code, e.params, e.message) : String(e)),
      )
    return () => {
      live = false
    }
  }, [latest, message])

  // The countdowns move once a minute
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  if (!user) return null

  const byTab = (tab: ChallengeTab) =>
    (list ?? []).filter((c) => challengeTab(c, user.id, now) === tab)
  const tab = chosen ?? CHALLENGE_TABS.find((k) => byTab(k).length) ?? 'waiting'
  const sorted = sortList(
    byTab(tab),
    listing.sort,
    (c) => c.createdAt,
    (c) => c.deadline,
  )
  const { items: shown, page, total } = paginate(sorted, listing.page, listing.size)
  const choose = (k: ChallengeTab) => {
    setChosen(k)
    listing.firstPage()
  }

  return (
    <PageMain>
      <Toolbar>
        <PageTitle>{t.navChallenges}</PageTitle>
        <Actions>
          {user.admin && (
            <Button type="button" onClick={() => setScheduling(true)}>
              <CalendarClock size={18} aria-hidden />
              {t.weeklyChallengeTitle}
            </Button>
          )}
          <Button type="button" $variant="primary" onClick={() => setCreating(true)}>
            <Plus size={18} aria-hidden />
            {t.newChallenge}
          </Button>
        </Actions>
      </Toolbar>
      {scheduling && <WeeklyChallengeDialog onClose={() => setScheduling(false)} />}
      {creating && (
        <ChallengeDialog
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false)
            setList((old) => [c, ...(old ?? []).filter((x) => x.id !== c.id)])
            choose('waiting')
          }}
        />
      )}
      <ListTools>
        <ChipStrip role="tablist" aria-label={t.navChallenges}>
          {CHALLENGE_TABS.map((k) => (
            <Chip
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              $active={tab === k}
              onClick={() => choose(k)}
            >
              {t.challengeTabs[k]}
              {list && <ChipCount n={byTab(k).length} />}
            </Chip>
          ))}
        </ChipStrip>
        <SortSelect
          value={listing.sort}
          options={LIST_SORTS}
          names={t.listSorts}
          onChange={listing.setSort}
        />
      </ListTools>
      {error && <ErrorText role="alert">{error}</ErrorText>}
      {list === null ? (
        <Muted>{t.loading}</Muted>
      ) : shown.length === 0 ? (
        <Card>
          <Muted>
            <Swords size={16} aria-hidden /> {t.noChallenges[tab]}
          </Muted>
        </Card>
      ) : (
        <>
          <Grid role="tabpanel" aria-label={t.challengeTabs[tab]}>
            {shown.map((c) => (
              <ChallengeCard key={c.id} c={c} userId={user.id} now={now} />
            ))}
          </Grid>
          <Pager
            items
            label={t.navChallenges}
            page={page}
            size={listing.size}
            total={total}
            onPage={listing.setPage}
            onSize={listing.setSize}
          />
        </>
      )}
    </PageMain>
  )
}
