// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { CARD_SNAPSHOT_LIMITS, type Me } from '../../shared/protocol.ts'
import { CardSnapshotService } from '../../worker/card-snapshots.ts'
import { MemoryStore } from '../../worker/store.ts'

const amy: Me = { id: 'u1', username: 'amy', admin: false, permissions: [] }
const profile = { id: 'ab12', name: 'A 隊', version: 4 }
const card = {
  templateId: 'wbf',
  profileId: 'ab12',
  cells: { 'wbf.defence.overcalls': { slot: 'wbf.defence.overcalls', text: '8-16', sources: [] } },
  notes: [],
  problems: [],
}
const docx = btoa(String.fromCharCode(80, 75, 3, 4, 1, 2, 3))

let store: MemoryStore
let snapshots: CardSnapshotService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000
  snapshots = new CardSnapshotService(store, () => time, (id) => (id === 'u1' ? 'amy' : undefined))
})

describe('convention card versions (BridgeHall e3-t09)', () => {
  it('numbers versions per template, keeps the card and the Word file, lists newest first', async () => {
    const first = await snapshots.create(amy, profile, { templateId: 'wbf', profileVersion: 4, card, docx, note: ' 春季賽 ' })
    expect(first).toEqual({
      profileId: 'ab12',
      templateId: 'wbf',
      n: 1,
      at: 1_000,
      by: 'u1',
      byName: 'amy',
      note: '春季賽',
      profileName: 'A 隊',
      profileVersion: 4,
      shared: false,
      docx: true,
    })
    time += 1
    // A version newer than the profile is not believed
    const simple = await snapshots.create(amy, profile, { templateId: 'ctcba-simple', profileVersion: 9, card })
    expect(simple).toMatchObject({ n: 1, docx: false, profileVersion: 4 })
    time += 1
    expect((await snapshots.create(amy, profile, { templateId: 'wbf', profileVersion: 3, card })).n).toBe(2)
    expect((await snapshots.list('ab12')).map((s) => `${s.templateId}/${s.n}`)).toEqual(['wbf/2', 'ctcba-simple/1', 'wbf/1'])
    expect(await snapshots.list('other')).toEqual([])

    expect((await snapshots.get('ab12', 'wbf', 1)).card).toEqual(card)
    expect([...(await snapshots.docx('ab12', 'wbf', 1))]).toEqual([80, 75, 3, 4, 1, 2, 3])
    await expect(snapshots.docx('ab12', 'ctcba-simple', 1)).rejects.toMatchObject({ code: 'cardSnapshotGone', status: 404 })
    await expect(snapshots.get('ab12', 'wbf', 9)).rejects.toMatchObject({ code: 'cardSnapshotGone', status: 404 })
  })

  it('turns the link on and off', async () => {
    await snapshots.create(amy, profile, { templateId: 'wbf', profileVersion: 4, card })
    expect((await snapshots.share('ab12', 'wbf', 1, true)).shared).toBe(true)
    expect((await snapshots.meta('ab12', 'wbf', 1)).shared).toBe(true)
    expect((await snapshots.get('ab12', 'wbf', 1)).card).toEqual(card)
    expect((await snapshots.share('ab12', 'wbf', 1, false)).shared).toBe(false)
    await expect(snapshots.share('ab12', 'wbf', 1, 'yes')).rejects.toMatchObject({ code: 'badContent' })
  })

  it('checks the shape and the sizes', async () => {
    await expect(snapshots.create(amy, profile, { templateId: 'WBF!', card })).rejects.toMatchObject({ code: 'badContent' })
    await expect(snapshots.create(amy, profile, { templateId: 'wbf', card: 'x' })).rejects.toMatchObject({ code: 'badContent' })
    await expect(snapshots.create(amy, profile, { templateId: 'wbf', card, docx: 'not base64!' })).rejects.toMatchObject({
      code: 'badContent',
    })
    const big = { ...card, notes: ['x'.repeat(CARD_SNAPSHOT_LIMITS.cardBytesMax)] }
    await expect(snapshots.create(amy, profile, { templateId: 'wbf', card: big })).rejects.toMatchObject({
      code: 'contentTooLarge',
      status: 413,
    })
    const bigDocx = 'A'.repeat(Math.ceil((CARD_SNAPSHOT_LIMITS.docxBytesMax * 4) / 3) + 8)
    await expect(snapshots.create(amy, profile, { templateId: 'wbf', card, docx: bigDocx })).rejects.toMatchObject({ status: 413 })
  })

  it('deletes one version, or all of a profile', async () => {
    await snapshots.create(amy, profile, { templateId: 'wbf', card, docx })
    await snapshots.create(amy, profile, { templateId: 'wbf', card, docx })
    await snapshots.remove('ab12', 'wbf', 1)
    expect((await snapshots.list('ab12')).map((s) => s.n)).toEqual([2])
    await snapshots.removeAll('ab12')
    expect(await snapshots.list('ab12')).toEqual([])
    expect((await store.list('')).size).toBe(0)
  })
})
