import type { Me } from '../shared/protocol.ts'
import { AuditLog } from './audit.ts'
import { getParts, isObject, isSlug, isString, putParts } from './book.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * TKU BridgeHall's glossary (BridgeHall e4-t05, e4-t07): the terms the handbook underlines in its
 * text and lists on its glossary page. The whole list is one value, edited and saved at once like
 * the categories; it lives at `book:glossary` (a header) with its body in `bookpart:glossary:<i>`,
 * so backups (`book*`) carry it. Nothing is cached: it is read on each request, which is one small
 * header and a part or two.
 */

/** One term (BridgeHall src/types/glossary.ts Term); `see` is a convention's slug */
export interface GlossaryTerm {
  term: string
  aliases: string[]
  definition: string
  see?: string
}

/**
 * GET /api/book/glossary. An empty list with version 0 means it was never edited online, so the
 * handbook's bundled list applies; `version` is what a save sends back as `baseVersion`.
 */
export interface BookGlossary {
  version: number
  terms: GlossaryTerm[]
  updatedAt?: number
  updatedBy?: string
}

export const GLOSSARY_LIMITS = { max: 500, termMax: 40, aliasesMax: 10, definitionMax: 1000 }

const KEY = 'book:glossary'
type Header = Omit<BookGlossary, 'terms'> & { parts: number }

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

/**
 * Throws `badContent` unless `value` is a list of terms: each with a name and a definition, no name
 * or alias used twice (ignoring case), `see` a slug when given. An empty list is allowed (every
 * term removed).
 */
export function checkGlossary(value: unknown): GlossaryTerm[] {
  if (!Array.isArray(value)) return fail('名詞表格式不正確')
  if (value.length > GLOSSARY_LIMITS.max) fail(`名詞最多 ${GLOSSARY_LIMITS.max} 條`)
  const names = new Set<string>()
  const claim = (name: string) => {
    const key = name.toLowerCase()
    if (names.has(key)) fail(`名詞重複：${name}`)
    names.add(key)
  }
  return value.map((t) => {
    if (!isObject(t)) return fail('名詞格式不正確')
    const term = isString(t.term) ? t.term.trim() : ''
    if (!term || term.length > GLOSSARY_LIMITS.termMax) fail(`名詞要有 1 到 ${GLOSSARY_LIMITS.termMax} 個字`)
    claim(term)
    if (t.aliases !== undefined && !(Array.isArray(t.aliases) && t.aliases.every(isString))) fail(`「${term}」的別名要是文字`)
    const aliases = [...new Set(((t.aliases as string[] | undefined) ?? []).map((a) => a.trim()).filter(Boolean))]
    if (aliases.length > GLOSSARY_LIMITS.aliasesMax) fail(`「${term}」的別名最多 ${GLOSSARY_LIMITS.aliasesMax} 個`)
    for (const alias of aliases) {
      if (alias.length > GLOSSARY_LIMITS.termMax) fail(`「${term}」的別名太長`)
      claim(alias)
    }
    const definition = isString(t.definition) ? t.definition.trim() : ''
    if (!definition || definition.length > GLOSSARY_LIMITS.definitionMax)
      fail(`「${term}」的解釋要有 1 到 ${GLOSSARY_LIMITS.definitionMax} 個字`)
    if (t.see !== undefined && t.see !== '' && !isSlug(t.see)) fail(`「${term}」連到的特約代號不正確`)
    return { term, aliases, definition, ...(isString(t.see) && t.see && { see: t.see }) }
  })
}

export class GlossaryService {
  private readonly store: Store
  private readonly now: () => number
  private readonly audit: AuditLog

  constructor(store: Store, now: () => number = Date.now, audit: AuditLog = new AuditLog(store, now)) {
    this.store = store
    this.now = now
    this.audit = audit
  }

  async get(): Promise<BookGlossary> {
    const header = await this.store.get<Header>(KEY)
    if (!header) return { version: 0, terms: [] }
    const { parts, ...info } = header
    return { ...info, terms: await getParts<GlossaryTerm[]>(this.store, 'glossary', parts) }
  }

  /**
   * Replaces the whole list. `baseVersion` is the version the editor started from (0 for the
   * bundled list); 409 `glossaryConflict` when someone saved since.
   */
  async save(actor: Me, body: { terms?: unknown; baseVersion?: unknown }): Promise<BookGlossary> {
    const terms = checkGlossary(body.terms)
    const header = await this.store.get<Header>(KEY)
    const version = header?.version ?? 0
    if (Number(body.baseVersion) !== version) throw new ClubError('glossaryConflict', { name: header?.updatedBy ?? '別人' }, 409)
    const parts = await putParts(this.store, 'glossary', terms, header?.parts ?? 0)
    const next: Header = { version: version + 1, updatedAt: this.now(), updatedBy: actor.username, parts }
    await this.store.put(KEY, next)
    await this.audit.record({ by: actor.username, action: 'book:glossary', target: 'glossary', version: next.version })
    return this.get()
  }
}

function cachedJson(request: Request, etag: string, body: string) {
  const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })
}

/** GET /api/book/glossary, for anyone without signing in; null for any other request */
export async function publicGlossaryResponse(glossary: GlossaryService, request: Request, pathname: string) {
  if (request.method !== 'GET' || pathname !== '/api/book/glossary') return null
  const list = await glossary.get()
  return cachedJson(request, `W/"book-glossary-${list.version}"`, JSON.stringify(list))
}
