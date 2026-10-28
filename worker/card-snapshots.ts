import { CARD_SNAPSHOT_LIMITS, type CardSnapshot, type CardSnapshotMeta, type Me } from '../shared/protocol.ts'
import { dropParts, getParts, isObject, isString, putParts } from './book.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * TKU BridgeHall's convention card versions (制度卡版本, E3 e3-t09, AC-3.7): each "publish" on the
 * handbook's card page keeps the card as filled then, and its Word file, so after a tournament
 * anyone can see which version was played; a version can be shared by link (read without signing
 * in) and the link turned off again.
 *
 * The card is the handbook's (its FilledCard); this checks only that it is an object and its size.
 * Who may read, publish, share or delete is the profile's rights (club.ts asks TeamService).
 *
 * Keys: `book:cardsnap:<profileId>:<templateId>:<n, 6 digits>` is the meta plus how many parts the
 * card and the Word file have; the card is in `bookpart:<key>`, the Word file (base64) in
 * `bookpart:<key>#docx`. Deleting a profile deletes its versions.
 */

interface Header {
  parts: number
  docxParts: number
}

const TEMPLATE_ID = /^[a-z][a-z0-9-]{0,39}$/
const prefixOf = (profileId: string) => `book:cardsnap:${profileId}:`
const keyOf = (profileId: string, templateId: string, n: number) => `${prefixOf(profileId)}${templateId}:${String(n).padStart(6, '0')}`
const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

export class CardSnapshotService {
  private readonly store: Store
  private readonly now: () => number
  private readonly nameOf: (userId: string) => string | undefined

  constructor(store: Store, now: () => number = Date.now, nameOf: (userId: string) => string | undefined = () => undefined) {
    this.store = store
    this.now = now
    this.nameOf = nameOf
  }

  private named(meta: CardSnapshotMeta): CardSnapshotMeta {
    const name = this.nameOf(meta.by)
    return name ? { ...meta, byName: name } : meta
  }

  /** A profile's versions on every template, newest first */
  async list(profileId: string): Promise<CardSnapshotMeta[]> {
    const all = await this.store.list<CardSnapshotMeta & Header>(prefixOf(profileId))
    return [...all.values()]
      .map(({ parts: _p, docxParts: _d, ...meta }) => this.named(meta))
      .sort((a, b) => b.at - a.at || b.n - a.n)
  }

  /** Publishes a version of `profile`'s card on `body.templateId` */
  async create(actor: Me, profile: { id: string; name: string; version: number }, body: Record<string, unknown>): Promise<CardSnapshotMeta> {
    const templateId = body.templateId
    if (!isString(templateId) || !TEMPLATE_ID.test(templateId)) fail('不認得的制度卡版型')
    if (!isObject(body.card)) fail('沒有制度卡內容')
    const cardBytes = new TextEncoder().encode(JSON.stringify(body.card)).length
    if (cardBytes > CARD_SNAPSHOT_LIMITS.cardBytesMax) throw new ClubError('contentTooLarge', {}, 413)
    let docx: string | undefined
    if (body.docx !== undefined) {
      if (!isString(body.docx) || !/^[A-Za-z0-9+/]+=*$/.test(body.docx)) fail('Word 檔格式不對')
      docx = body.docx as string
      if ((docx.length * 3) / 4 > CARD_SNAPSHOT_LIMITS.docxBytesMax) throw new ClubError('contentTooLarge', {}, 413)
    }
    const existing = await this.store.list<CardSnapshotMeta & Header>(prefixOf(profile.id))
    if (existing.size >= CARD_SNAPSHOT_LIMITS.perProfile) fail(`每個制度集最多保留 ${CARD_SNAPSHOT_LIMITS.perProfile} 個制度卡版本，請先刪掉舊的`)
    const n = 1 + Math.max(0, ...[...existing.values()].filter((m) => m.templateId === templateId).map((m) => m.n))
    const key = keyOf(profile.id, templateId as string, n)
    const meta: CardSnapshotMeta = {
      profileId: profile.id,
      templateId: templateId as string,
      n,
      at: this.now(),
      by: actor.id,
      note: String(body.note ?? '').trim().slice(0, CARD_SNAPSHOT_LIMITS.noteMax),
      profileName: profile.name,
      // The version the card was filled from: the handbook says which, never newer than the profile
      profileVersion: Math.min(profile.version, Math.max(0, Math.floor(Number(body.profileVersion) || 0))),
      shared: false,
      docx: !!docx,
    }
    const parts = await putParts(this.store, key, body.card)
    const docxParts = docx ? await putParts(this.store, `${key}#docx`, docx) : 0
    await this.store.put<CardSnapshotMeta & Header>(key, { ...meta, parts, docxParts })
    return this.named(meta)
  }

  private async header(profileId: string, templateId: string, n: number) {
    const key = keyOf(profileId, templateId, n)
    const header = Number.isInteger(n) && n > 0 && TEMPLATE_ID.test(templateId) ? await this.store.get<CardSnapshotMeta & Header>(key) : undefined
    if (!header) throw new ClubError('cardSnapshotGone', {}, 404)
    return { key, header }
  }

  /** The version's meta, to check who may read it before reading the rest */
  async meta(profileId: string, templateId: string, n: number): Promise<CardSnapshotMeta> {
    const { parts: _p, docxParts: _d, ...meta } = (await this.header(profileId, templateId, n)).header
    return this.named(meta)
  }

  async get(profileId: string, templateId: string, n: number): Promise<CardSnapshot> {
    const { key, header } = await this.header(profileId, templateId, n)
    const { parts, docxParts: _d, ...meta } = header
    return { ...this.named(meta), card: await getParts<Record<string, unknown>>(this.store, key, parts) }
  }

  /** The Word file's bytes; 404 when the version has none */
  async docx(profileId: string, templateId: string, n: number): Promise<Uint8Array> {
    const { key, header } = await this.header(profileId, templateId, n)
    if (!header.docxParts) throw new ClubError('cardSnapshotGone', {}, 404)
    const base64 = await getParts<string>(this.store, `${key}#docx`, header.docxParts)
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  }

  /** Turns the version's link on or off */
  async share(profileId: string, templateId: string, n: number, shared: unknown): Promise<CardSnapshotMeta> {
    if (typeof shared !== 'boolean') fail('shared 要是 true 或 false')
    const { key, header } = await this.header(profileId, templateId, n)
    const next = { ...header, shared: shared as boolean }
    await this.store.put(key, next)
    const { parts: _p, docxParts: _d, ...meta } = next
    return this.named(meta)
  }

  async remove(profileId: string, templateId: string, n: number) {
    const { key, header } = await this.header(profileId, templateId, n)
    await dropParts(this.store, key, header.parts)
    await dropParts(this.store, `${key}#docx`, header.docxParts)
    await this.store.delete(key)
  }

  /** Every version of a profile, when the profile is deleted */
  async removeAll(profileId: string) {
    for (const [key, header] of await this.store.list<Header>(prefixOf(profileId))) {
      await dropParts(this.store, key, header.parts)
      await dropParts(this.store, `${key}#docx`, header.docxParts)
      await this.store.delete(key)
    }
  }
}
