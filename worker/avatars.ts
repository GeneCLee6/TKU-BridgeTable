import { AVATAR_MAX_BYTES } from '../shared/avatar.ts'
import { ClubError } from './errors.ts'
import type { StoredAvatar } from './service.ts'

/**
 * The HTTP side of uploaded avatars (e1-t34), without Cloudflare APIs so the tests can call it:
 * reading an upload and answering `GET /api/avatar/:id` with headers a browser may cache.
 */

/** A year: the address changes with every new picture (`?v=`), so an answer can be kept that long */
export const AVATAR_LONG_CACHE = 'private, max-age=31536000, immutable'
/** Without the right version (an old page, or no `?v=`), the browser checks each time with the ETag */
export const AVATAR_CHECK_CACHE = 'private, no-cache'

/** The upload's bytes; anything over the limit is refused before or after it is read */
export async function readAvatarUpload(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ClubError('avatarTooLarge', { max: AVATAR_MAX_BYTES / 1024 }, 413)
  if (Number(request.headers.get('Content-Length') ?? 0) > AVATAR_MAX_BYTES) throw tooLarge()
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > AVATAR_MAX_BYTES) throw tooLarge()
  return bytes
}

/**
 * The picture with its ETag (the version) and caching: a year when the address names the current
 * version, otherwise checked each time; `If-None-Match` with the current version gets 304. A
 * member with no picture gets 404 (`noAvatar`) and the browser shows the default avatar
 */
export function avatarResponse(avatar: StoredAvatar | undefined, request: Request): Response {
  if (!avatar) throw new ClubError('noAvatar', {}, 404)
  const etag = `"avatar-${avatar.version}"`
  const current = new URL(request.url).searchParams.get('v') === String(avatar.version)
  const headers = {
    ETag: etag,
    'Cache-Control': current ? AVATAR_LONG_CACHE : AVATAR_CHECK_CACHE,
    'X-Content-Type-Options': 'nosniff',
  }
  const asked = request.headers.get('If-None-Match')
  if (asked && asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(avatar.bytes, {
    headers: { ...headers, 'Content-Type': avatar.type, 'Content-Length': String(avatar.bytes.length) },
  })
}
