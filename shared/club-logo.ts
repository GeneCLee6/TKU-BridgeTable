import { CLUB_PARAM } from './clubs.ts'

/**
 * A club's logo (AC-12.2, ARCHITECTURE.md §1「社團 Logo」). The browser crops the picture to a square
 * and shrinks it (`src/lib/avatarImage.ts`, as for avatars); the Worker never decodes a picture,
 * it reads the file's structure (`inspectLogo`) and keeps only a square WebP, PNG or JPEG of at
 * most LOGO_PIXELS with nothing but picture data in it: no text chunks, no EXIF or XMP, no bytes
 * after the picture's end. So the address that serves it to anyone (the sign-in page needs it)
 * cannot carry an arbitrary file. It lives in the club's own object (`meta:logo`), no R2.
 *
 * Pure: shared by the Worker and the pages.
 */

/** The square the browser sends (also the home-screen icon's size) */
export const LOGO_PIXELS = 512
/** The smallest square taken: a logo must still read on a home screen */
export const LOGO_MIN_PIXELS = 64
/** The largest file; a 512×512 WebP logo is usually 15–60 KB, PNG is the fallback for browsers without WebP */
export const LOGO_MAX_BYTES = 128 * 1024
/** Changes per club: 5 at once, then one a minute */
export const LOGO_BURST = 5
export const LOGOS_PER_SECOND = 1 / 60

export type LogoType = 'image/webp' | 'image/png' | 'image/jpeg'

/** A logo named without its bytes: the version (the address changes with it), the type and the square's side */
export interface ClubLogoRef {
  version: number
  type: LogoType
  size: number
}

/** The public address of a club's logo: the club in the query (an `<img>` cannot send `X-Club-Id`), the version for caching */
export const CLUB_LOGO_API = '/api/logo'
export const clubLogoUrl = (clubId: string, version: number) =>
  `${CLUB_LOGO_API}?${CLUB_PARAM}=${encodeURIComponent(clubId)}&v=${version}`
/** An application's logo, for the platform owner only (淡江's object, the owner's own session) */
export const applicationLogoUrl = (applicationId: string) => `/api/platform/applications/${encodeURIComponent(applicationId)}/logo`

/** What the structure check found */
export interface LogoInfo {
  type: LogoType
  width: number
  height: number
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Picture data and colour only: what a canvas writes, never text (tEXt, zTXt, iTXt) or EXIF (eXIf) */
const PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'iCCP', 'sBIT', 'pHYs', 'bKGD'])

function inspectPng(b: Uint8Array): LogoInfo | null {
  let at = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let first = true
  let pictures = 0
  while (at + 12 <= b.length) {
    const length = u32be(b, at)
    const type = ascii(b, at + 4, 4)
    const end = at + 12 + length
    if (end > b.length || !PNG_CHUNKS.has(type)) return null
    if (first) {
      if (type !== 'IHDR' || length !== 13) return null
      width = u32be(b, at + 8)
      height = u32be(b, at + 12)
      first = false
    }
    if (type === 'IDAT') pictures++
    if (type === 'IEND') return end === b.length && pictures > 0 ? { type: 'image/png', width, height } : null
    at = end
  }
  return null
}

/** Picture data, transparency, animation frames' absence and a colour profile: never EXIF or XMP */
const WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP'])

function inspectWebp(b: Uint8Array): LogoInfo | null {
  if (u32le(b, 4) + 8 !== b.length) return null
  let at = 12
  let size: { width: number; height: number } | null = null
  let picture = false
  while (at + 8 <= b.length) {
    const type = ascii(b, at, 4)
    const length = u32le(b, at + 4)
    const data = at + 8
    const end = data + length + (length & 1)
    if (end > b.length || !WEBP_CHUNKS.has(type)) return null
    if (type === 'VP8X') {
      // An animation (flag 0x02) is not a logo
      if (length < 10 || b[data] & 0x02) return null
      size = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 }
    } else if (type === 'VP8 ') {
      if (length < 10 || !startsWith(b, [0x9d, 0x01, 0x2a], data + 3)) return null
      size ??= { width: (b[data + 6] | (b[data + 7] << 8)) & 0x3fff, height: (b[data + 8] | (b[data + 9] << 8)) & 0x3fff }
      picture = true
    } else if (type === 'VP8L') {
      if (length < 5 || b[data] !== 0x2f) return null
      const bits = u32le(b, data + 1)
      size ??= { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      picture = true
    }
    at = end
  }
  return at === b.length && picture && size ? { type: 'image/webp', ...size } : null
}

/** APP0 (JFIF), APP2 (a colour profile) and APP14 (Adobe's colour flag): never APP1 (EXIF, XMP) or a comment */
const JPEG_MARKERS_KEPT = new Set([0xe0, 0xe2, 0xee, 0xdb, 0xc4, 0xdd])
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2])

function inspectJpeg(b: Uint8Array): LogoInfo | null {
  let at = 2
  let size: { width: number; height: number } | null = null
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1]
    const length = u16be(b, at + 2)
    if (length < 2 || at + 2 + length > b.length) return null
    if (JPEG_FRAMES.has(marker)) {
      if (length < 8) return null
      size = { height: u16be(b, at + 5), width: u16be(b, at + 7) }
    } else if (marker === 0xda) {
      // The scan runs to the end of the file, which must be the end-of-image marker
      return size && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9 ? { type: 'image/jpeg', ...size } : null
    } else if (!JPEG_MARKERS_KEPT.has(marker)) return null
    at += 2 + length
  }
  return null
}

/**
 * The picture's type and size from its structure, or null when it is not a plain WebP, PNG or
 * JPEG picture: anything that is not picture data (text, metadata, trailing bytes) is refused.
 * Checksums and the compressed data are not decoded: the browser shows it as the type it is served as
 */
export function inspectLogo(bytes: Uint8Array): LogoInfo | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return inspectPng(bytes)
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return inspectWebp(bytes)
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return inspectJpeg(bytes)
  return null
}

/** Why a logo is refused, or null: too large, not a plain picture, not a square of LOGO_MIN_PIXELS–LOGO_PIXELS */
export function logoProblem(bytes: Uint8Array): 'logoTooLarge' | 'logoBadFormat' | null {
  if (bytes.length > LOGO_MAX_BYTES) return 'logoTooLarge'
  const info = inspectLogo(bytes)
  if (!info || info.width !== info.height || info.width < LOGO_MIN_PIXELS || info.width > LOGO_PIXELS) return 'logoBadFormat'
  return null
}
