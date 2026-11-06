import { FILE_LIMITS, type FileTicket, type FileType, type FileUrls, type UploadedFile } from '../../shared/files.ts'
import { canvasEncoder, encodeAvatar, type Size } from './avatarImage.ts'
import { request } from './api.ts'

/**
 * A post's pictures (e13-t13, ARCHITECTURE.md §5.14): the browser does all the image work, the
 * Worker only checks the size and the first bytes (free plan: 10 ms of CPU a request).
 *
 * - A JPEG, PNG or WebP is redrawn on a canvas within `FILE_LIMITS.pixels` on its long side and
 *   written as WebP (JPEG where the browser cannot) at a quality that fits `FILE_LIMITS.maxBytes`;
 *   redrawing also drops what the camera wrote into the file (where it was taken, EXIF).
 * - A GIF goes as it is, so it keeps moving, if it fits `maxBytes`.
 * - Each gets a still thumbnail within `FILE_LIMITS.thumbPixels` (BridgeHall's lists use it).
 * - Then a single-use pass (`POST /api/files/ticket`) and the two `PUT`s.
 */

/** The pictures the file picker offers; SVG never (it may carry script) */
export const POST_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const

export type PostImageError = 'badType' | 'unreadable' | 'tooLarge'

/** Why a picture cannot be uploaded, before anything is sent */
export class PostImageProblem extends Error {
  readonly reason: PostImageError
  constructor(reason: PostImageError) {
    super(reason)
    this.reason = reason
  }
}

export const isPostImageType = (type: string): type is FileType => (POST_IMAGE_TYPES as readonly string[]).includes(type)

/** The size that fits within `max` on its long side, never larger than the original */
export function fitWithin(size: Size, max: number): Size {
  const scale = Math.min(1, max / Math.max(size.width, size.height))
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

/** How a picked file goes up: as it is (a GIF that fits), redrawn (the others), or not at all */
export function uploadPlan(file: { type: string; size: number }): 'asIs' | 'redraw' | PostImageError {
  if (!isPostImageType(file.type)) return 'badType'
  if (file.type === 'image/gif') return file.size <= FILE_LIMITS.maxBytes ? 'asIs' : 'tooLarge'
  return 'redraw'
}

/** The picture redrawn within `max` pixels and `maxBytes`; null when nothing fits */
async function redraw(image: ImageBitmap, max: number, maxBytes: number): Promise<Blob | null> {
  const { width, height } = fitWithin(image, max)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  return encodeAvatar(canvasEncoder(canvas), maxBytes)
}

const put = (url: string, blob: Blob) =>
  request<{ file: UploadedFile }>(url, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } }).then((r) => r.file)

/** The pass and the two uploads, for a picture and thumbnail already made */
export async function uploadPrepared(picture: Blob, thumb: Blob | null): Promise<UploadedFile> {
  if (!isPostImageType(picture.type)) throw new PostImageProblem('badType')
  const ticket = await request<FileTicket>('/api/files/ticket', {
    method: 'POST',
    body: JSON.stringify({ purpose: 'post', type: picture.type, size: picture.size }),
  })
  const file = await put(ticket.uploadUrl, picture)
  return thumb ? put(ticket.thumbUrl, thumb) : file
}

/**
 * Shrinks (or keeps, a GIF) a picture the member picked and uploads it with its thumbnail. Throws a
 * `PostImageProblem` for a file that cannot go, and the API's errors (`ApiError`) as they come
 */
export async function uploadPostImage(file: File): Promise<UploadedFile> {
  const plan = uploadPlan(file)
  if (plan !== 'asIs' && plan !== 'redraw') throw new PostImageProblem(plan)
  let image: ImageBitmap
  try {
    image = await createImageBitmap(file)
  } catch {
    throw new PostImageProblem('unreadable')
  }
  try {
    const picture = plan === 'asIs' ? file : await redraw(image, FILE_LIMITS.pixels, FILE_LIMITS.maxBytes)
    if (!picture) throw new PostImageProblem('unreadable')
    const thumb = await redraw(image, FILE_LIMITS.thumbPixels, FILE_LIMITS.thumbMaxBytes)
    return await uploadPrepared(picture, thumb)
  } finally {
    image.close()
  }
}

/** Fresh signed addresses for these pictures; the ones the reader may not see are left out */
export const fileUrls = (keys: string[]) =>
  request<FileUrls>('/api/files/urls', { method: 'POST', body: JSON.stringify({ keys }) }).then((r) => r.urls)
