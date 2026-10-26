import { AVATAR_MAX_BYTES } from '../../shared/avatar.ts'

/**
 * Cropping and shrinking an uploaded avatar in the browser (e1-t34), so the Worker never decodes a
 * picture: the member moves and zooms the picture under a square frame, and what is in the frame
 * becomes a 256×256 WebP (JPEG where the browser cannot write WebP), at a lower quality until it
 * fits `AVATAR_MAX_BYTES`. The maths is kept apart from the canvas so it can be tested.
 */

/** The pictures the file picker offers; anything else is turned down before it is read */
export const AVATAR_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
/** How far in the slider zooms, from "the whole short side fits" */
export const AVATAR_MAX_ZOOM = 4

/** Where the picture sits under the frame: `zoom` ≥ 1, `x`/`y` its top-left corner in frame pixels (≤ 0) */
export interface Crop {
  zoom: number
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** Frame pixels per picture pixel at this zoom: at 1 the short side just fills the frame */
export const cropScale = (image: Size, frame: number, zoom: number) => (frame / Math.min(image.width, image.height)) * zoom

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** Keeps the frame covered: the picture can never be moved or zoomed out so that an edge shows */
export function clampCrop(crop: Crop, image: Size, frame: number): Crop {
  const zoom = clamp(crop.zoom, 1, AVATAR_MAX_ZOOM)
  const scale = cropScale(image, frame, zoom)
  return {
    zoom,
    x: clamp(crop.x, frame - image.width * scale, 0),
    y: clamp(crop.y, frame - image.height * scale, 0),
  }
}

/** The picture zoomed out and centred: where the cropper starts */
export function initialCrop(image: Size, frame: number): Crop {
  const scale = cropScale(image, frame, 1)
  return { zoom: 1, x: (frame - image.width * scale) / 2, y: (frame - image.height * scale) / 2 }
}

/** Zooms keeping the frame's point (`cx`, `cy`, the centre by default) over the same spot of the picture */
export function zoomCrop(crop: Crop, zoom: number, image: Size, frame: number, cx = frame / 2, cy = frame / 2): Crop {
  const before = cropScale(image, frame, crop.zoom)
  const after = cropScale(image, frame, clamp(zoom, 1, AVATAR_MAX_ZOOM))
  const ratio = after / before
  return clampCrop({ zoom, x: cx - (cx - crop.x) * ratio, y: cy - (cy - crop.y) * ratio }, image, frame)
}

/** Moves the picture by a drag of (`dx`, `dy`) frame pixels */
export const moveCrop = (crop: Crop, dx: number, dy: number, image: Size, frame: number): Crop =>
  clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, image, frame)

/** The square of the picture, in its own pixels, that the frame shows */
export function sourceSquare(crop: Crop, image: Size, frame: number) {
  const scale = cropScale(image, frame, crop.zoom)
  return { sx: (0 - crop.x) / scale, sy: (0 - crop.y) / scale, size: frame / scale }
}

/** Writes the canvas in a type at a quality (canvas.toBlob); null when it could not */
export type EncodeCanvas = (type: string, quality: number) => Promise<Blob | null>

const QUALITIES = [0.86, 0.76, 0.64, 0.5, 0.38]

/**
 * The smallest good-enough file: WebP from the best quality down, and JPEG the same way where the
 * browser wrote something else for WebP (toBlob falls back to PNG); null if nothing fits
 */
export async function encodeAvatar(encode: EncodeCanvas, maxBytes = AVATAR_MAX_BYTES): Promise<Blob | null> {
  for (const type of ['image/webp', 'image/jpeg']) {
    for (const quality of QUALITIES) {
      const blob = await encode(type, quality)
      if (!blob || blob.type !== type) break
      if (blob.size <= maxBytes) return blob
    }
  }
  return null
}

/** `canvas.toBlob` as a promise */
export const canvasEncoder =
  (canvas: HTMLCanvasElement): EncodeCanvas =>
  (type, quality) =>
    new Promise((resolve) => canvas.toBlob(resolve, type, quality))
