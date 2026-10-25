/**
 * Default avatars (e1-t18): the member's initial on a colour chosen from their id, so the same
 * member always looks the same everywhere (name plates, the People tab, the profile card) without
 * storing anything. Uploaded pictures come later (e1-t34).
 */

/** Which of `count` colours belongs to this id: a small string hash (FNV-1a), stable across browsers */
export function avatarSlot(id: string, count: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % count
}

const LETTER = /\p{L}|\p{N}/u
const LATIN = /^[\p{Script=Latin}\p{N}]$/u

/**
 * One character for a Chinese, Japanese or Korean name (王小明 → 王), up to two capitals for a
 * name in Latin letters (Gene Lee → GL, amy → A), "?" when there is no letter at all
 */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const firsts = words.map((word) => [...word].find((ch) => LETTER.test(ch))).filter((ch): ch is string => !!ch)
  if (!firsts.length) return '?'
  if (!LATIN.test(firsts[0])) return firsts[0]
  return firsts
    .filter((ch) => LATIN.test(ch))
    .slice(0, 2)
    .join('')
    .toUpperCase()
}
