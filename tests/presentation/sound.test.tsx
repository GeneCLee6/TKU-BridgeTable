import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardView, DirectMessage, Notification, NotificationsView, TableView } from '../../shared/protocol.ts'
import { ToastProvider } from '../../src/components/Toast.tsx'
import { DEFAULT_SOUND_PREFS, soundDecision, type SoundEvent } from '../../src/lib/sound/events.ts'
import { useClubSounds, useTableSounds, type TableSoundInput } from '../../src/lib/sound/hooks.ts'
import { openConversation, resetSoundState, setTableActivity, showChat, trickTaken } from '../../src/lib/sound/player.ts'
import { synthesize } from '../../src/lib/sound/synth.ts'
import { PACE } from '../../src/lib/motion.ts'
import { AccountPage } from '../../src/pages/AccountPage.tsx'
import { AuthProvider } from '../../src/state/AuthContext.tsx'
import { PreferencesProvider, usePreferences } from '../../src/state/PreferencesContext.tsx'
import { auctionBoard, playBoard, resultBoard, table as tableWire } from '../visual/fixtures.ts'

// DESIGN.md §4「音效」: which events make which sound, and the member's sound settings. The Web
// Audio synthesis is mocked: these tests only see which sound was asked for, in which style

vi.mock('../../src/lib/sound/synth.ts', () => ({ synthesize: vi.fn(), unlockAudio: vi.fn() }))

const played = () => vi.mocked(synthesize).mock.calls.map(([style, event]) => `${style}:${event}`)
const events = () => vi.mocked(synthesize).mock.calls.map(([, event]) => event)

const PREFS_KEY = 'tku-bridge-table:prefs'
const storePrefs = (prefs: object) => window.localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: 'zh', tableTourSeen: true, ...prefs }))
const stored = () => JSON.parse(window.localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
}

beforeEach(() => {
  resetSoundState()
  vi.mocked(synthesize).mockClear()
  // Each test moves the clock on, so the throttle (the same sound once in 120 ms) never joins two tests
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 60_000)
})

afterEach(() => {
  setHidden(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the sound settings', () => {
  function Show() {
    const p = usePreferences()
    return (
      <>
        <output>{[p.sound, p.soundStyle, p.soundVolume, p.soundBids, p.soundChat, p.soundKibitz, p.vibrate].join(' ')}</output>
        <button type="button" onClick={p.toggleSound}>
          speaker
        </button>
      </>
    )
  }

  it('starts with the president’s choices: on, 實體牌桌, 中, no bids, chat, watching, no vibration', () => {
    render(
      <PreferencesProvider>
        <Show />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('true table medium false true true false')
    expect(DEFAULT_SOUND_PREFS).toMatchObject({ sound: true, soundStyle: 'table', soundVolume: 'medium', soundBids: false })
  })

  it('remembers them, ignores what it does not know, and the speaker button brings back a style turned off', async () => {
    storePrefs({ soundStyle: 'off', soundVolume: 'deafening', soundBids: true, vibrate: true })
    render(
      <PreferencesProvider>
        <Show />
      </PreferencesProvider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('true off medium true true true true')
    await userEvent.setup({ advanceTimers: () => undefined }).click(screen.getByRole('button', { name: 'speaker' }))
    expect(screen.getByRole('status')).toHaveTextContent('true table medium')
    expect(stored()).toMatchObject({ sound: true, soundStyle: 'table' })
  })
})

describe('when a sound plays', () => {
  const prefs = DEFAULT_SOUND_PREFS
  const where = { hidden: false }

  it('lets people watching hear only the deal, the cards, the tricks and a match’s other room', () => {
    const heard = (['deal', 'card', 'otherCard', 'trick', 'turn', 'made', 'chat', 'score', 'notify'] as SoundEvent[]).filter(
      (e) => soundDecision(e, prefs, { hidden: false, kibitzing: true }).sound,
    )
    expect(heard).toEqual(['deal', 'card', 'otherCard', 'trick', 'score'])
    expect(soundDecision('deal', { ...prefs, soundKibitz: false }, { hidden: false, kibitzing: true }).sound).toBe(false)
  })

  it('plays only what needs you, messages and chat in a background tab', () => {
    const heard = (['deal', 'otherCard', 'trick', 'turn', 'turnPlay', 'attention', 'slow', 'made', 'notify', 'chat'] as SoundEvent[]).filter(
      (e) => soundDecision(e, prefs, { hidden: true }).sound,
    )
    expect(heard).toEqual(['turn', 'turnPlay', 'attention', 'slow', 'notify', 'chat'])
  })

  it('keeps bids quiet unless asked, and chat when turned off', () => {
    expect(soundDecision('bid', prefs, where).sound).toBe(false)
    expect(soundDecision('pass', { ...prefs, soundBids: true }, where).sound).toBe(true)
    expect(soundDecision('chat', { ...prefs, soundChat: false }, where).sound).toBe(false)
  })

  it('is silent when muted or 關閉, but a phone set to vibrate still buzzes for what needs you', () => {
    expect(soundDecision('turn', { ...prefs, sound: false }, where)).toEqual({ sound: false, vibrate: false })
    expect(soundDecision('turn', { ...prefs, soundStyle: 'off', vibrate: true }, where)).toEqual({ sound: false, vibrate: true })
    expect(soundDecision('otherCard', { ...prefs, vibrate: true }, where).vibrate).toBe(false)
  })
})

// ── At the table ──

const base = tableWire(playBoard) as TableView

function input(change: Partial<TableSoundInput> = {}, table: Partial<TableView> = {}): TableSoundInput {
  return {
    table: { ...base, ...table },
    userId: 'amy',
    host: false,
    playedCount: 9,
    lastPlayer: 'E',
    collecting: undefined,
    myTurn: null,
    slow: false,
    ...change,
  }
}

function Harness(props: TableSoundInput) {
  useTableSounds(props)
  return null
}

function atTable(first: TableSoundInput) {
  const view = render(
    <PreferencesProvider>
      <Harness {...first} />
    </PreferencesProvider>,
  )
  return (next: TableSoundInput) =>
    view.rerender(
      <PreferencesProvider>
        <Harness {...next} />
      </PreferencesProvider>,
    )
}

const withBoard = (board: Partial<BoardView>): Partial<TableView> => ({ board: { ...playBoard, ...board } })

describe('the table’s sounds', () => {
  it('makes no sound for what was already there when the page opened', () => {
    atTable(input({ myTurn: 'play' }))
    expect(played()).toEqual([])
  })

  it('lands each card as its glide ends: yours (and dummy’s as declarer) louder than the others’', () => {
    const next = atTable(input())
    next(input({ playedCount: 10, lastPlayer: 'S' }))
    next(input({ playedCount: 11, lastPlayer: 'W' }))
    expect(played()).toEqual(['table:card', 'table:otherCard'])
    expect(vi.mocked(synthesize).mock.calls[0][2]).toBe(PACE.landsAfterS)
    const [own, other] = vi.mocked(synthesize).mock.calls.map((c) => c[3])
    expect(other).toBeLessThan(own)
    vi.setSystemTime(Date.now() + 1000)
    next(input({ playedCount: 12, lastPlayer: 'N' }))
    expect(events().at(-1)).toBe('card')
  })

  it('plays one sound when several cards come at once', () => {
    const next = atTable(input())
    next(input({ playedCount: 12, lastPlayer: 'N' }))
    expect(events()).toEqual(['card'])
  })

  it('sweeps a trick away softly, the same whoever won it', () => {
    const next = atTable(input())
    next(input({ collecting: '5:2' }))
    expect(events()).toEqual(['trick'])
  })

  it('shuffles for a new board, and nothing else from it', () => {
    const next = atTable(input())
    next(input({ playedCount: 0, myTurn: 'call' }, withBoard({ ...auctionBoard, boardNo: 6 })))
    expect(events()).toEqual(['deal'])
  })

  it('calls you with the wooden "dum"; your card only when the tab is in the background', () => {
    const next = atTable(input())
    next(input({ myTurn: 'call' }))
    expect(events()).toEqual(['turn'])
    next(input({ myTurn: null }))
    next(input({ myTurn: 'play' }))
    expect(events()).toEqual(['turn'])
    next(input({ myTurn: null }))
    setHidden(true)
    next(input({ myTurn: 'play' }))
    expect(events()).toEqual(['turn', 'turnPlay'])
  })

  it('knocks twice when a claim waits on your answer, and once more when you are slow', () => {
    const next = atTable(input())
    next(input({}, withBoard({ claim: { seat: 'E', tricks: 3, accepted: [], approvers: ['S'] } })))
    next(input({ slow: true }))
    expect(events()).toEqual(['attention', 'slow'])
  })

  it('says made or down after the last card lands, never whose side it was', () => {
    let next = atTable(input())
    next(input({ playedCount: 52, lastPlayer: 'W' }, { board: resultBoard }))
    expect(events()).toEqual(['otherCard', 'made'])
    expect(vi.mocked(synthesize).mock.calls[1][2]).toBeGreaterThan(PACE.landsAfterS)

    vi.mocked(synthesize).mockClear()
    vi.setSystemTime(Date.now() + 1000)
    next = atTable(input())
    next(input({}, { board: { ...resultBoard, result: { declarerTricks: 9, scoreNS: -100, claimed: true } } }))
    expect(events()).toEqual(['down'])
  })

  it('keeps others’ calls quiet unless the member turned bid sounds on', () => {
    const before = { ...auctionBoard, auction: auctionBoard.auction.slice(0, 5) }
    let next = atTable(input({}, withBoard(before)))
    next(input({}, withBoard(auctionBoard)))
    expect(events()).toEqual([])

    storePrefs({ soundBids: true })
    next = atTable(input({}, withBoard(before)))
    next(input({}, withBoard(auctionBoard)))
    expect(events()).toEqual(['pass'])
  })

  it('lets people watching hear the cards but not the result', () => {
    const watching = { mySeat: null }
    const next = atTable(input({}, watching))
    next(input({ playedCount: 52, lastPlayer: 'S' }, { ...watching, board: resultBoard }))
    expect(events()).toEqual(['otherCard'])
  })

  it('taps for chat only while the chat panel is closed, never for your own or a robot’s', () => {
    let chat = base.chat
    const say = (id: string, userId: string) => ({ chat: (chat = [...chat, { id, at: 0, userId, username: userId, text: 'hi' }]) })
    const next = atTable(input())
    next(input({}, say('c3', 'robot:gib:N')))
    next(input({}, say('c4', 'amy')))
    expect(events()).toEqual([])
    next(input({}, say('c5', 'ben')))
    expect(events()).toEqual(['chat'])

    vi.mocked(synthesize).mockClear()
    const hide = showChat()
    next(input({}, say('c6', 'dan')))
    expect(events()).toEqual([])
    hide()
  })

  it('tells the host when someone sits down, and when the table is full', () => {
    const empty = { seats: { ...base.seats, W: null, E: null } }
    const next = atTable(input({ host: true }, empty))
    next(input({ host: true }, { seats: { ...base.seats, W: null } }))
    expect(events()).toEqual(['seat'])
    next(input({ host: true }))
    expect(events()).toEqual(['seat', 'full'])
  })

  it('is silent with the style 關閉, and buzzes a phone set to vibrate', () => {
    const vibrate = vi.fn(() => true)
    vi.stubGlobal('navigator', { ...navigator, vibrate })
    storePrefs({ soundStyle: 'off', vibrate: true })
    const next = atTable(input())
    next(input({ myTurn: 'call', playedCount: 10, lastPlayer: 'W' }))
    expect(events()).toEqual([])
    expect(vibrate).toHaveBeenCalledWith([40])
  })

  it('plays the 簡潔電子 style when chosen', () => {
    storePrefs({ soundStyle: 'digital' })
    const next = atTable(input())
    next(input({ collecting: '5:2' }))
    expect(played()).toEqual(['digital:trick'])
  })
})

// ── Outside the table ──

function Club(props: { notifications: NotificationsView | null; directs: DirectMessage[] }) {
  useClubSounds({ userId: 'amy', ...props })
  return null
}

function inClub(first: Parameters<typeof Club>[0]) {
  const view = render(
    <PreferencesProvider>
      <Club {...first} />
    </PreferencesProvider>,
  )
  return (next: Parameters<typeof Club>[0]) =>
    view.rerender(
      <PreferencesProvider>
        <Club {...next} />
      </PreferencesProvider>,
    )
}

const note = (id: string, kind: Notification['kind']): Notification => ({ id, at: 0, kind, params: {}, read: false }) as Notification
const bell = (...items: Notification[]): NotificationsView => ({ items, unread: items.length })
const dm = (id: number, from: string): DirectMessage => ({ id, from, to: from === 'amy' ? 'ben' : 'amy', text: 'hi', at: 0 })

describe('news', () => {
  it('rings for a new notification, not for those already there', () => {
    const next = inClub({ notifications: bell(note('n1', 'friendOnline')), directs: [] })
    expect(events()).toEqual([])
    next({ notifications: bell(note('n2', 'tableInvited'), note('n1', 'friendOnline')), directs: [] })
    expect(events()).toEqual(['notify'])
  })

  it('has its own sounds for a team match starting and ending (the same whoever won) and a challenge’s results', () => {
    const next = inClub({ notifications: bell(), directs: [] })
    next({ notifications: bell(note('a', 'matchStarted')), directs: [] })
    next({ notifications: bell(note('b', 'matchFinished'), note('a', 'matchStarted')), directs: [] })
    next({ notifications: bell(note('c', 'challengeResults'), note('b', 'matchFinished'), note('a', 'matchStarted')), directs: [] })
    expect(events()).toEqual(['matchStart', 'matchEnd', 'challengeResult'])
  })

  it('rings for a direct message from someone else, unless that conversation is open', () => {
    const next = inClub({ notifications: null, directs: [] })
    next({ notifications: null, directs: [dm(1, 'amy')] })
    expect(events()).toEqual([])
    const close = openConversation('ben')
    next({ notifications: null, directs: [dm(1, 'amy'), dm(2, 'ben')] })
    expect(events()).toEqual([])
    close()
    next({ notifications: null, directs: [dm(1, 'amy'), dm(2, 'ben'), dm(3, 'ben')] })
    expect(events()).toEqual(['notify'])
  })

  it('waits for the trick to be taken while you play, and for the board’s end with a challenge’s results', () => {
    setTableActivity('play')
    const next = inClub({ notifications: bell(), directs: [] })
    next({ notifications: bell(note('a', 'tableInvited')), directs: [] })
    expect(events()).toEqual([])
    act(() => trickTaken())
    expect(events()).toEqual(['notify'])

    next({ notifications: bell(note('b', 'challengeResults'), note('a', 'tableInvited')), directs: [] })
    act(() => trickTaken())
    expect(events()).toEqual(['notify'])
    setTableActivity('none')
    expect(events()).toEqual(['notify', 'challengeResult'])
  })
})

// ── 我的帳號 ──

describe('the sound card on 我的帳號', () => {
  function renderAccount() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ user: { id: 'amy', username: 'amy', admin: false, permissions: [] } }), { status: 200 })),
    )
    render(
      <PreferencesProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter>
              <AccountPage />
            </MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </PreferencesProvider>,
    )
  }

  it('chooses a style, a volume and the kinds of sound, and plays a sample of each style', async () => {
    vi.useRealTimers()
    renderAccount()
    const user = userEvent.setup()
    expect(screen.getByRole('radio', { name: /實體牌桌/ })).toBeChecked()
    expect(within(screen.getByRole('group', { name: '音量' })).getByRole('radio', { name: '中' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /叫品聲/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /震動提醒/ })).toHaveAccessibleName(/iPhone 的 Safari 不支援/)

    await user.click(screen.getByRole('button', { name: '試聽「簡潔電子」' }))
    expect(played()[0]).toBe('digital:turn')
    expect(new Set(played().map((p) => p.split(':')[0]))).toEqual(new Set(['digital']))

    await user.click(screen.getByRole('radio', { name: /簡潔電子/ }))
    await user.click(within(screen.getByRole('group', { name: '音量' })).getByRole('radio', { name: '輕' }))
    await user.click(screen.getByRole('checkbox', { name: /叫品聲/ }))
    await user.click(screen.getByRole('checkbox', { name: /震動提醒/ }))
    expect(stored()).toMatchObject({ soundStyle: 'digital', soundVolume: 'soft', soundBids: true, vibrate: true })
    // 關閉 has nothing to listen to
    expect(screen.queryByRole('button', { name: /試聽「關閉」/ })).toBeNull()
  })
})

