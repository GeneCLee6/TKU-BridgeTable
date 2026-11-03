import type { FileUrls } from '../shared/files.ts'
import type { PostBlock } from '../shared/forum.ts'
import type { Me } from '../shared/protocol.ts'
import { ClubError } from './errors.ts'
import type { FileService } from './files.ts'
import { postImageKeys, type ForumService } from './forum.ts'

/**
 * Forum pictures (the table's e13-t13, ARCHITECTURE.md §5.14) between the forum (`worker/forum.ts`)
 * and the R2 files (`worker/files.ts`), without Cloudflare APIs so the tests can call it:
 *
 * - **Whose**: a post may add only pictures its author uploaded (the ones already in it stay), so a
 *   picture belongs to one member and goes with their post.
 * - **Who sees it**: `POST /api/files/urls` signs a `post/` picture only for its uploader or someone
 *   who may see a post using it (`ForumService.imagesInUse`, the same rule as the posts): once an
 *   officer hides a post, nobody else gets a fresh address, and the ones already handed out stop
 *   working within `FILE_LIMITS.urlMs` plus the hour they are rounded to.
 * - **Gone with the post**: deleting a post, or editing a picture out of it, takes the picture from
 *   R2 unless another post uses it. A picture uploaded and never posted stays until its uploader's
 *   account is deleted (`FileService.forget`).
 */

/** The `post/` pictures `body` (a post being written or edited) adds to `before` */
export function addedImageKeys(body: unknown, before: readonly PostBlock[] = []): string[] {
  const blocks = body && typeof body === 'object' ? (body as { blocks?: unknown }).blocks : undefined
  if (!Array.isArray(blocks)) return []
  const had = new Set(postImageKeys(before))
  const keys = new Set<string>()
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const { kind, assetId } = block as { kind?: unknown; assetId?: unknown }
    if (kind === 'image' && typeof assetId === 'string' && !had.has(assetId)) keys.add(assetId)
  }
  return [...keys]
}

/** Refuses a picture the member did not upload (or that is gone): 403 `forumImageNotYours` */
export async function checkImagesOwned(files: Pick<FileService, 'meta'>, userId: string, keys: readonly string[]) {
  for (const key of keys) {
    const meta = await files.meta(key)
    if (meta?.owner !== userId) throw new ClubError('forumImageNotYours', {}, 403)
  }
}

/**
 * `POST /api/files/urls` for `viewer`: articles' pictures and e-books as before (their own pages
 * decide who reads them); a forum picture only for its uploader or a reader of a post using it
 */
export async function signFiles(files: Pick<FileService, 'urls'>, forum: Pick<ForumService, 'imagesInUse'>, viewer: Me, keys: unknown): Promise<FileUrls> {
  const asked = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : []
  const seen = forum.imagesInUse(asked, viewer)
  return files.urls(keys, (key, meta) => !key.startsWith('post/') || meta.owner === viewer.id || seen.has(key))
}

/** Takes from R2 the pictures that no post uses any more (a post deleted or edited, e13-t13); returns the keys removed */
export async function releaseImages(files: Pick<FileService, 'removeKeys'>, forum: Pick<ForumService, 'imagesInUse'>, keys: readonly string[]): Promise<string[]> {
  const posts = keys.filter((key) => key.startsWith('post/'))
  if (!posts.length) return []
  const used = forum.imagesInUse(posts, 'all')
  return files.removeKeys(posts.filter((key) => !used.has(key)))
}

/** The pictures `before` had that `after` no longer has */
export const droppedImageKeys = (before: readonly PostBlock[], after: readonly PostBlock[]): string[] => {
  const kept = new Set(postImageKeys(after))
  return [...new Set(postImageKeys(before))].filter((key) => !kept.has(key))
}
