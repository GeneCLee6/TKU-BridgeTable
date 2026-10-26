import {
  parsePracticeSettings,
  parsePresetName,
  PRACTICE_PRESET_NAME_MAX,
  PRACTICE_PRESETS_MAX,
  type SavedPractice,
} from '../shared/practice.ts'
import type { RobotKind } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * A member's saved practice settings (存成我的設定, `e10-t16`, ARCHITECTURE.md §5.11): named sets
 * of the practice dialog's settings, at most PRACTICE_PRESETS_MAX each, kept under
 * `practicePresets:<userId>` as one list (newest first). Only the member reads and writes their own:
 * every call is by their id. The settings are checked as a new practice table checks them, so a
 * saved one opens as it is; a deal set is kept as its choice (which set, which boards), never as cards.
 * Like `ClubService` this never touches a Cloudflare API.
 */

export const practicePresetsKey = (userId: string) => `practicePresets:${userId}`

export class PracticePresets {
  private readonly store: Store
  private readonly now: () => number
  private readonly newId: () => string

  constructor(store: Store, now: () => number, newId: () => string) {
    this.store = store
    this.now = now
    this.newId = newId
  }

  async list(userId: string): Promise<SavedPractice[]> {
    return (await this.store.get<SavedPractice[]>(practicePresetsKey(userId))) ?? []
  }

  /**
   * Saves settings under a name; the same name again replaces them (keeping their id). `kind` is
   * the member's own robots, as for a new table. Answers the whole list
   */
  async save(userId: string, body: unknown, kind: RobotKind): Promise<SavedPractice[]> {
    const { name: rawName, settings: rawSettings } = (body ?? {}) as { name?: unknown; settings?: unknown }
    const name = parsePresetName(rawName)
    if (!name) throw new ClubError('badPresetName', { max: PRACTICE_PRESET_NAME_MAX })
    const parsed = parsePracticeSettings(rawSettings, kind)
    if ('field' in parsed)
      throw parsed.problem
        ? new ClubError('dealConflict', { where: parsed.problem })
        : new ClubError('badPracticeSettings', { field: parsed.field })
    const list = await this.list(userId)
    const before = list.find((p) => p.name === name)
    if (!before && list.length >= PRACTICE_PRESETS_MAX) throw new ClubError('practicePresetsFull', { max: PRACTICE_PRESETS_MAX })
    const saved: SavedPractice = { id: before?.id ?? this.newId(), name, settings: parsed.settings, savedAt: this.now() }
    const next = [saved, ...list.filter((p) => p !== before)]
    await this.store.put(practicePresetsKey(userId), next)
    return next
  }

  async remove(userId: string, id: string): Promise<SavedPractice[]> {
    const list = await this.list(userId)
    if (!list.some((p) => p.id === id)) throw new ClubError('presetGone', {}, 404)
    const next = list.filter((p) => p.id !== id)
    if (next.length) await this.store.put(practicePresetsKey(userId), next)
    else await this.store.delete(practicePresetsKey(userId))
    return next
  }

  /** When an account is deleted */
  async removeAll(userId: string) {
    await this.store.delete(practicePresetsKey(userId))
  }
}
