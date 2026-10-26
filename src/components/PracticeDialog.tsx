import { Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import styled from 'styled-components'
import { SEATS } from '../../shared/cards.ts'
import { conditionsProblem } from '../../shared/dealer.ts'
import {
  DEFAULT_PRACTICE_SETTINGS,
  PRACTICE_DEALS,
  PRACTICE_PRESETS_MAX,
  PRACTICE_SEAT,
  type PracticeSetChoice,
  type PracticeSettings,
  type SavedPractice,
} from '../../shared/practice.ts'
import { PRACTICE_TABLE_SETTINGS, type RobotKind, type TableAccess } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import { badHands, conditionsOf, emptyForms, formsOf, problemText, type SeatForms } from '../lib/practiceForm.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { PracticeConditions } from './PracticeConditions.tsx'
import { PracticeSetPicker } from './PracticeSetPicker.tsx'
import { AccessChoices, Backdrop, Buttons, Choice, Group, Panel } from './TableSettingsDialog.tsx'
import { Button, ErrorText, Input, Muted } from './ui.tsx'

/**
 * Opening a practice table (`e10-t04`, AC-10.2): which hands to deal (a preset, the member's own
 * conditions for each of the four seats or a whole hand, or a deal set, `e10-t16`), which TKB to
 * play with, Just Declare, the bidding practice (`e10-t15`): bidding only, and which seats besides
 * South the member bids for; 顯示四家, and the member's saved settings (存成我的設定). The server checks
 * it all again (`parsePracticeSettings`) and says when the conditions cannot be met; conditions
 * that contradict each other are told here before sending. Only a member who may use the club's
 * system (`tkuSystem`) chooses the robots' system; for anyone else there is one TKB, the 2/1 one
 * (ROBOT.md §7)
 */

const Wide = styled(Panel)`
  max-width: 540px;
`

const Choices = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
`

const Check = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
`

const SeatChoices = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
`

const Presets = styled.ul`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;

  & > li {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }
`

const Save = styled.div`
  display: flex;
  gap: 8px;
  align-items: center;

  & > input { flex: 1; min-width: 0; }
`

export function PracticeDialog({
  onSubmit,
  onClose,
  robotKinds = ['gib'],
}: {
  /** The practice settings, and who may watch (hidden unless changed: only the invited) */
  onSubmit: (settings: PracticeSettings, access: TableAccess) => void
  onClose: () => void
  /** The systems the member may seat TKB in (`robotKindsFor`), the first one chosen to begin with */
  robotKinds?: readonly RobotKind[]
}) {
  const { t, message } = usePreferences()
  const titleId = useId()
  const [settings, setSettings] = useState<PracticeSettings>(() => ({ ...DEFAULT_PRACTICE_SETTINGS, robotKind: robotKinds[0] }))
  const [forms, setForms] = useState<SeatForms>(emptyForms)
  const [set, setSet] = useState<PracticeSetChoice | undefined>()
  const [access, setAccess] = useState<TableAccess>(PRACTICE_TABLE_SETTINGS.access)
  const [presets, setPresets] = useState<SavedPractice[] | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null)
  const first = useRef<HTMLInputElement>(null)
  const seats = settings.seats ?? [PRACTICE_SEAT]

  useEffect(() => first.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    let live = true
    api
      .practicePresets()
      .then(({ presets }) => live && setPresets(presets))
      .catch(() => live && setPresets([]))
    return () => {
      live = false
    }
  }, [])

  // Only what was chosen goes to the server
  const built = (): PracticeSettings => {
    const { conditions: _conditions, set: _set, ...rest } = settings
    return {
      ...rest,
      ...(settings.deal === 'custom' && { conditions: conditionsOf(forms) }),
      ...(settings.deal === 'set' && set && { set }),
    }
  }
  const unwritten = settings.deal === 'custom' ? badHands(forms) : []
  const problem =
    settings.deal !== 'custom'
      ? null
      : unwritten.length
        ? t.practiceProblems.hand(t.seatNames[unwritten[0]])
        : (() => {
            const where = conditionsProblem(conditionsOf(forms))
            return where && problemText(t, where)
          })()
  const ready = !problem && (settings.deal !== 'set' || !!set)

  const apply = (preset: SavedPractice) => {
    const { conditions, set: saved, ...rest } = preset.settings
    setSettings({ ...DEFAULT_PRACTICE_SETTINGS, ...rest, robotKind: robotKinds.includes(rest.robotKind) ? rest.robotKind : robotKinds[0] })
    setForms(formsOf(conditions))
    setSet(saved)
    setName(preset.name)
    setNote(null)
  }
  const fail = (error: unknown) =>
    setNote({ text: error instanceof ApiError && error.code ? message(error.code, error.params, error.message) : t.genericError, error: true })
  const save = async () => {
    try {
      const { presets } = await api.savePracticePreset(name, built())
      setPresets(presets)
      setNote({ text: t.practicePresetSaved(presets[0].name), error: false })
    } catch (error) {
      fail(error)
    }
  }
  const remove = async (preset: SavedPractice) => {
    try {
      setPresets((await api.removePracticePreset(preset.id)).presets)
    } catch (error) {
      fail(error)
    }
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Wide role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{t.practiceTitle}</h2>
        <Muted>{t.practiceIntro}</Muted>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (ready) onSubmit(built(), access)
          }}
        >
          {presets && presets.length > 0 && (
            <Group>
              <legend>{t.practicePresets}</legend>
              <Presets>
                {presets.map((preset) => (
                  <li key={preset.id}>
                    <Button type="button" $size="sm" aria-label={t.practicePresetApply(preset.name)} onClick={() => apply(preset)}>
                      {preset.name}
                    </Button>
                    <Button type="button" $size="sm" $variant="ghost" aria-label={t.practicePresetRemove(preset.name)} onClick={() => remove(preset)}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </li>
                ))}
              </Presets>
            </Group>
          )}
          <Group>
            <legend>{t.practiceDealLegend}</legend>
            <Choices>
              {PRACTICE_DEALS.map((deal, i) => (
                <Choice key={deal}>
                  <input
                    ref={i === 0 ? first : undefined}
                    type="radio"
                    name="deal"
                    checked={settings.deal === deal}
                    // A deal set's boards are dealt as they are: no Just Declare
                    onChange={() => setSettings({ ...settings, deal, ...(deal === 'set' && { justDeclare: false }) })}
                  />
                  <span>{t.practiceDeals[deal].label}</span>
                  <Muted>{t.practiceDeals[deal].hint}</Muted>
                </Choice>
              ))}
            </Choices>
            {settings.deal !== 'random' && settings.deal !== 'set' && <Muted>{t.practiceSouthDeals}</Muted>}
          </Group>
          {settings.deal === 'custom' && (
            <Group>
              <legend>{t.practiceSeatLegend}</legend>
              <PracticeConditions forms={forms} onChange={setForms} />
              {problem && <ErrorText role="alert">{problem}</ErrorText>}
            </Group>
          )}
          {settings.deal === 'set' && (
            <Group>
              <legend>{t.practiceSetLegend}</legend>
              <PracticeSetPicker value={set} onChange={setSet} />
            </Group>
          )}
          {robotKinds.length > 1 && (
            <Group>
              <legend>{t.practiceRobots}</legend>
              {robotKinds.map((kind) => (
                <Choice key={kind}>
                  <input
                    type="radio"
                    name="robotKind"
                    checked={settings.robotKind === kind}
                    onChange={() => setSettings({ ...settings, robotKind: kind })}
                  />
                  <span>{t.robots[kind]}</span>
                </Choice>
              ))}
            </Group>
          )}
          <Group>
            <Choice>
              <input
                type="checkbox"
                checked={settings.justDeclare}
                disabled={!!settings.biddingOnly || settings.deal === 'set'}
                onChange={(event) => setSettings({ ...settings, justDeclare: event.target.checked })}
              />
              <span>{t.justDeclare}</span>
              <Muted>{t.justDeclareHint}</Muted>
            </Choice>
            <Choice>
              <input
                type="checkbox"
                checked={!!settings.biddingOnly}
                disabled={settings.justDeclare}
                onChange={(event) =>
                  // Bidding for other seats goes with bidding only (nobody plays several hands)
                  setSettings(
                    event.target.checked
                      ? { ...settings, biddingOnly: true }
                      : { ...settings, biddingOnly: false, seats: [PRACTICE_SEAT] },
                  )
                }
              />
              <span>{t.biddingOnly}</span>
              <Muted>{t.biddingOnlyHint}</Muted>
            </Choice>
            <Choice>
              <input
                type="checkbox"
                checked={!!settings.showHands}
                onChange={(event) => setSettings({ ...settings, showHands: event.target.checked })}
              />
              <span>{t.practiceShowHands}</span>
              <Muted>{t.practiceShowHandsHint}</Muted>
            </Choice>
          </Group>
          <Group>
            <legend>{t.practiceSeatsLegend}</legend>
            <SeatChoices>
              {SEATS.map((seat) => (
                <Check key={seat}>
                  <input
                    type="checkbox"
                    checked={seats.includes(seat)}
                    disabled={seat === PRACTICE_SEAT || !settings.biddingOnly}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        seats: SEATS.filter((s) => (s === seat ? event.target.checked : seats.includes(s))),
                      })
                    }
                  />
                  {t.seatNames[seat]}
                </Check>
              ))}
            </SeatChoices>
            <Muted>{t.practiceSeatsHint}</Muted>
          </Group>
          <AccessChoices value={access} onChange={setAccess} legend={t.practiceAccess} />
          <Group>
            <legend>{t.practicePresetSave}</legend>
            <Save>
              <Input
                $size="sm"
                value={name}
                maxLength={30}
                aria-label={t.practicePresetName}
                placeholder={t.practicePresetName}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="button" $size="sm" disabled={!name.trim() || !ready} onClick={save}>
                {t.practicePresetSave}
              </Button>
            </Save>
            {note ? (
              note.error ? (
                <ErrorText role="alert">{note.text}</ErrorText>
              ) : (
                <Muted role="status">{note.text}</Muted>
              )
            ) : (
              <Muted>{t.practicePresetsHint(PRACTICE_PRESETS_MAX)}</Muted>
            )}
          </Group>
          <Buttons>
            <Button type="button" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" $variant="primary" disabled={!ready}>
              {t.practiceOpen}
            </Button>
          </Buttons>
        </form>
      </Wide>
    </Backdrop>
  )
}
