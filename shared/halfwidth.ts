/**
 * Full-width ASCII to half-width (社長 2026-11-03). A Chinese or Japanese input method in full-width
 * mode types ＡＢＣ１２３ where the member meant ABC123; sign-in names, passwords, codes and email
 * addresses are always the half-width ones. The sign-in forms convert as the member types
 * (src/lib/useHalfWidth.ts) and the server converts again before it checks anything
 * (worker/service.ts, worker/auth.ts), so an older page or another client gets the same answer.
 *
 * Only U+FF01–U+FF5E (the full-width forms of `!` to `~`) and U+3000 (the ideographic space)
 * change; everything else, Chinese characters included, stays as it is. Each character maps to one
 * character, so the length and a caret position stay the same.
 */
const FULL_WIDTH = /[\uFF01-\uFF5E\u3000]/g
const ASCII = /[\x20-\x7E]/g
const OFFSET = 0xff01 - 0x21

export function toHalfWidth(text: string): string {
  return text.replace(FULL_WIDTH, (c) => (c === '\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - OFFSET)))
}

/**
 * The other way: every printable ASCII character to its full-width form and a space to U+3000.
 * Only for the server's check of a password saved, before the forms converted, while the input
 * method was in full-width mode (worker/auth.ts `matchPassword`): the page now sends it half-width
 */
export function toFullWidth(text: string): string {
  return text.replace(ASCII, (c) => (c === ' ' ? '\u3000' : String.fromCharCode(c.charCodeAt(0) + OFFSET)))
}

/** A sign-in name, invite code or one-time code from a request: a string, half-width, trimmed */
export const credentialText = (value: unknown): string => toHalfWidth(String(value ?? '')).trim()
