/**
 * Uploaded avatars (e1-t34). The browser crops and shrinks the picture (`src/lib/avatarImage.ts`);
 * the Worker only checks the size and the file's first bytes and keeps it in the club's storage
 * (`avatar:<userId>`, ARCHITECTURE.md §5). Both sites load it from the same address,
 * `/api/avatar/<id>?v=<version>`: the version changes with every upload, so a new picture shows at
 * once while an unchanged one stays in the browser's cache.
 */

/** The square the browser sends, in pixels */
export const AVATAR_PIXELS = 256
/** The largest upload; a 256×256 WebP or JPEG is usually 10–40 KB */
export const AVATAR_MAX_BYTES = 64 * 1024
/** Uploads and removals per member: 5 at once, then one a minute */
export const AVATAR_BURST = 5
export const AVATARS_PER_SECOND = 1 / 60

export type AvatarType = 'image/webp' | 'image/jpeg' | 'image/png'

/** Where a member's avatar is; `version` is `PublicUser.avatar` */
export const avatarUrl = (userId: string, version: number) =>
  `/api/avatar/${encodeURIComponent(userId)}?v=${version}`

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)

/** The picture's type from its first bytes (magic numbers), or null when it is none of the three */
export function sniffAvatar(bytes: Uint8Array): AvatarType | null {
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  return null
}
