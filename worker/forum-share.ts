import type { PostBlock } from '../shared/forum.ts'

/**
 * The table's history records a post being written or edited points at that it did not before
 * (e13-t07, AC-13.3): the `record` blocks of the browser's `blocks`, read before `ForumService`
 * checks the rest, so the club can check each board may be shared (`ClubService.checkShareable`)
 * before anything is saved. Records the post already had were checked when they were added (or come
 * from before the check, and stay as they were); a malformed body yields none here and is refused by
 * the forum's own checks.
 */
export function addedRecordIds(body: unknown, before: readonly PostBlock[] = []): string[] {
  const blocks = body && typeof body === 'object' ? (body as { blocks?: unknown }).blocks : undefined
  if (!Array.isArray(blocks)) return []
  const had = new Set(before.flatMap((b) => (b.kind === 'record' ? [b.tableRecordId] : [])))
  const ids = new Set<string>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const { kind, tableRecordId } = block as { kind?: unknown; tableRecordId?: unknown }
    if (kind === 'record' && typeof tableRecordId === 'string' && !had.has(tableRecordId)) ids.add(tableRecordId)
  }
  return [...ids]
}
