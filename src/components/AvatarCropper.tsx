import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import styled, { useTheme } from 'styled-components'
import { AVATAR_MAX_BYTES, AVATAR_PIXELS } from '../../shared/avatar.ts'
import type { Me } from '../../shared/protocol.ts'
import { api, ApiError } from '../lib/api.ts'
import {
  AVATAR_MAX_ZOOM,
  canvasEncoder,
  clampCrop,
  encodeAvatar,
  initialCrop,
  moveCrop,
  sourceSquare,
  zoomCrop,
  type Crop,
} from '../lib/avatarImage.ts'
import { usePreferences } from '../state/PreferencesContext.tsx'
import { Button, Card, ErrorText, Muted } from './ui.tsx'

/**
 * 裁切頭像 (e1-t34): the chosen picture under a square frame, moved by dragging (or the arrow
 * keys) and zoomed with the slider (or the wheel, or + and -). The frame's canvas is the upload
 * itself, 256×256; the circle over it is only CSS, so the saved square has no mask drawn in.
 */

const FRAME = AVATAR_PIXELS

const Backdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: ${({ theme }) => theme.colors.overlay};
`

const Panel = styled(Card)`
  width: 100%;
  max-width: 360px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  color: ${({ theme }) => theme.colors.text};

  & > h2 {
    margin: 0 0 8px;
    font-size: 20px;
    color: ${({ theme }) => theme.colors.primaryStrong};
  }
`

const Stage = styled.div`
  position: relative;
  width: min(${FRAME}px, 100%);
  aspect-ratio: 1;
  margin: 12px auto;
  overflow: hidden;
  border-radius: ${({ theme }) => theme.radius.sm};
  touch-action: none;

  /* The round avatar others will see; outside it is dimmed */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 ${FRAME}px ${({ theme }) => theme.colors.overlay};
    pointer-events: none;
  }
`

const Frame = styled.canvas`
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  &:active { cursor: grabbing; }
  &:focus-visible { outline: 3px solid ${({ theme }) => theme.colors.focus}; outline-offset: -3px; }
`

const Zoom = styled.label`
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
`

const Buttons = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
`

/** Reads the picture; null when the browser cannot */
function loadImage(file: Blob): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image.naturalWidth && image.naturalHeight ? image : null)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })
}

export function AvatarCropper({ file, onClose, onSaved }: { file: File; onClose: () => void; onSaved: (user: Me) => void }) {
  const { t, message } = usePreferences()
  const theme = useTheme()
  const titleId = useId()
  const hintId = useId()
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const size = image ? { width: image.naturalWidth, height: image.naturalHeight } : null

  useEffect(() => {
    let cancelled = false
    void loadImage(file).then((loaded) => {
      if (cancelled) return
      if (!loaded) return setError(t.avatarUnreadable)
      setImage(loaded)
      setCrop(initialCrop({ width: loaded.naturalWidth, height: loaded.naturalHeight }, FRAME))
    })
    return () => {
      cancelled = true
    }
  }, [file, t])

  // The frame shows exactly what will be uploaded
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d')
    if (!ctx || !image || !crop) return
    const { sx, sy, size: side } = sourceSquare(crop, { width: image.naturalWidth, height: image.naturalHeight }, FRAME)
    ctx.imageSmoothingQuality = 'high'
    // A transparent picture gets the page's surface behind it, not black
    ctx.fillStyle = theme.colors.surface
    ctx.fillRect(0, 0, FRAME, FRAME)
    ctx.drawImage(image, sx, sy, side, side, 0, 0, FRAME, FRAME)
  }, [image, crop, theme])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** Frame pixels per screen pixel: the frame shrinks on a narrow phone */
  const ratio = () => FRAME / (canvas.current?.getBoundingClientRect().width || FRAME)

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const from = drag.current
    if (!from || from.id !== event.pointerId || !crop || !size) return
    const r = ratio()
    setCrop(moveCrop(crop, (event.clientX - from.x) * r, (event.clientY - from.y) * r, size, FRAME))
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }
  const onPointerUp = () => {
    drag.current = null
  }
  const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    if (!crop || !size) return
    const rect = event.currentTarget.getBoundingClientRect()
    const r = ratio()
    const zoom = crop.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)
    setCrop(zoomCrop(crop, zoom, size, FRAME, (event.clientX - rect.left) * r, (event.clientY - rect.top) * r))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!crop || !size) return
    const step = event.shiftKey ? 32 : 8
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    if (moves[event.key]) setCrop(moveCrop(crop, ...moves[event.key], size, FRAME))
    else if (event.key === '+' || event.key === '=') setCrop(zoomCrop(crop, crop.zoom * 1.1, size, FRAME))
    else if (event.key === '-') setCrop(zoomCrop(crop, crop.zoom / 1.1, size, FRAME))
    else return
    event.preventDefault()
  }

  const save = async () => {
    if (!canvas.current || !crop) return
    setBusy(true)
    setError(null)
    try {
      const picture = await encodeAvatar(canvasEncoder(canvas.current))
      if (!picture) throw new ApiError('', 413, 'avatarTooLarge', { max: AVATAR_MAX_BYTES / 1024 })
      onSaved((await api.uploadAvatar(picture)).user)
    } catch (err) {
      setError(err instanceof ApiError && err.code ? message(err.code, err.params, err.message) : t.genericError)
      setBusy(false)
    }
  }

  return (
    <Backdrop onClick={(event) => event.target === event.currentTarget && onClose()}>
      <Panel role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId}>
        <h2 id={titleId}>{t.avatarCropTitle}</h2>
        <Muted id={hintId}>{t.avatarCropHint}</Muted>
        <Stage>
          <Frame
            ref={canvas}
            width={FRAME}
            height={FRAME}
            tabIndex={0}
            role="img"
            aria-label={t.avatarFrame}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          />
        </Stage>
        <Zoom>
          {t.avatarZoom}
          <input
            type="range"
            min={1}
            max={AVATAR_MAX_ZOOM}
            step={0.01}
            value={crop?.zoom ?? 1}
            disabled={!crop}
            onChange={(e) => crop && size && setCrop(clampCrop(zoomCrop(crop, Number(e.target.value), size, FRAME), size, FRAME))}
          />
        </Zoom>
        {error && <ErrorText role="alert">{error}</ErrorText>}
        <Buttons>
          <Button type="button" $variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="button" $variant="primary" $busy={busy} disabled={!crop || busy} onClick={() => void save()}>
            {busy ? t.saving : t.save}
          </Button>
        </Buttons>
      </Panel>
    </Backdrop>
  )
}
